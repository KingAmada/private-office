import { uid, now, message } from './db.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const normalizeLabel = value => String(value || '')
  .trim()
  .replace(/[?.!,;:]+$/g, '')
  .replace(/^(?:my|the)\s+/i, '')
  .replace(/\s+/g, ' ')
  .slice(0, 160);
const norm = value => normalizeLabel(value).toLowerCase();

const forbidden = text => /\b(?:card\s+pin|pin\s+number|cvv|cvc|otp|one[- ]time\s+(?:password|code)|seed\s+phrase|recovery\s+(?:code|phrase)|private\s+key|secret\s+key)\b/i.test(String(text || ''));

export function detectVaultStore(text) {
  const raw = String(text || '').trim();
  if (!/\bpassword\b/i.test(raw)) return null;
  if (forbidden(raw)) return { blocked: true };
  const patterns = [
    /^(?:remember\s+(?:that\s+)?)?(?:my\s+)?password\s+(?:for|to)\s+(.+?)\s+is\s+(.+)$/i,
    /^(?:remember\s+(?:that\s+)?)?(.+?)\s+(?:account\s+)?password\s+is\s+(.+)$/i,
    /^(?:save|store)\s+(?:my\s+)?(.+?)\s+password\s+(?:as|is)\s+(.+)$/i
  ];
  for (const p of patterns) {
    const m = raw.match(p);
    if (!m) continue;
    const label = normalizeLabel(m[1]);
    const secret = String(m[2] || '').trim();
    if (label && secret) return { label, secret };
  }
  return null;
}

export function detectVaultRetrieve(text) {
  const raw = String(text || '').trim();
  if (!/\bpassword\b/i.test(raw)) return null;
  if (forbidden(raw)) return { blocked: true };
  const patterns = [
    /^(?:what(?:'s| is)|whats)\s+(?:my|the)\s+password\s+(?:for|to)\s+(.+?)[?.!]*$/i,
    /^(?:get|show|tell|give)\s+me\s+(?:my|the)?\s*password\s+(?:for|to)\s+(.+?)[?.!]*$/i,
    /^(?:what(?:'s| is)|whats)\s+(.+?)\s+password[?.!]*$/i,
    /^(.+?)\s+password\s*\??$/i
  ];
  for (const p of patterns) {
    const m = raw.match(p);
    if (!m) continue;
    const label = normalizeLabel(m[1]);
    if (label) return { label };
  }
  return null;
}

function bytesToB64(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(value) {
  const s = atob(String(value || ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function masterKey(env) {
  const raw = String(env.VAULT_MASTER_KEY || '');
  if (raw.length < 32) throw new Error('Private Vault encryption key is not configured');
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(raw));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptSecret(env, labelNorm, secret) {
  const key = await masterKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`private-office-v1:${labelNorm}`) }, key, enc.encode(secret));
  return { secret_ct: bytesToB64(ct), iv: bytesToB64(iv) };
}
async function decryptSecret(env, row) {
  const key = await masterKey(env);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(row.iv), additionalData: enc.encode(`private-office-v1:${row.label_norm}`) }, key, b64ToBytes(row.secret_ct));
  return dec.decode(pt);
}

async function audit(env, user, secretId, action) {
  try { await env.DB.prepare('INSERT INTO vault_events(id,secret_id,person_id,action,created_at) VALUES(?,?,?,?,?)').bind(uid(), secretId || null, user.person_id, action, now()).run(); } catch {}
}

async function putSecret(env, user, label, secret, overwrite = true) {
  const labelNorm = norm(label);
  if (!labelNorm) throw new Error('Credential label is missing');
  const existing = await env.DB.prepare('SELECT id FROM vault_secrets WHERE label_norm=? LIMIT 1').bind(labelNorm).first();
  if (existing && !overwrite) return existing.id;
  const encrypted = await encryptSecret(env, labelNorm, secret);
  const t = now();
  if (existing) {
    await env.DB.prepare('UPDATE vault_secrets SET label=?,secret_ct=?,iv=?,updated_at=?,created_by=? WHERE id=?')
      .bind(normalizeLabel(label), encrypted.secret_ct, encrypted.iv, t, user.person_id, existing.id).run();
    await audit(env, user, existing.id, 'update');
    return existing.id;
  }
  const id = uid();
  await env.DB.prepare('INSERT INTO vault_secrets(id,label,label_norm,username,secret_ct,iv,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(id, normalizeLabel(label), labelNorm, null, encrypted.secret_ct, encrypted.iv, user.person_id, t, t).run();
  await audit(env, user, id, 'create');
  return id;
}

async function findSecret(env, label) {
  const q = norm(label);
  let row = await env.DB.prepare('SELECT * FROM vault_secrets WHERE label_norm=? LIMIT 1').bind(q).first();
  if (row) return row;
  row = await env.DB.prepare('SELECT * FROM vault_secrets WHERE label_norm LIKE ? OR ? LIKE (\'%\' || label_norm || \'%\') ORDER BY updated_at DESC LIMIT 1').bind(`%${q}%`, q).first();
  return row || null;
}

export async function handleVaultChat(env, user, text) {
  const store = detectVaultStore(text);
  const get = detectVaultRetrieve(text);
  if (!store && !get) return null;

  const label = normalizeLabel(store?.label || get?.label || 'credential');
  if (store?.blocked || get?.blocked) {
    const reply = 'Private Office does not store or reveal card PINs, CVVs, OTPs, recovery or seed phrases, or private keys.';
    await message(env, { personId: user.person_id, role: 'user', text: 'Sensitive credential request.' });
    await message(env, { role: 'assistant', text: reply, visibleTo: user.role === 'staff' ? user.person_id : null });
    return json({ ok: true, reply });
  }

  if (user.role !== 'owner') {
    const reply = 'Private Vault is owner-only.';
    await message(env, { personId: user.person_id, role: 'user', text: `Private Vault request for ${label}.` });
    await message(env, { role: 'assistant', text: reply, visibleTo: user.person_id });
    return json({ ok: true, reply });
  }

  if (!env.VAULT_MASTER_KEY || String(env.VAULT_MASTER_KEY).length < 32) {
    const reply = 'Private Vault needs its encryption key configured before I can safely store or reveal passwords.';
    await message(env, { personId: user.person_id, role: 'user', text: `Private Vault request for ${label}.` });
    await message(env, { role: 'assistant', text: reply });
    return json({ ok: true, reply, vault_config_required: true });
  }

  if (store?.secret) {
    await putSecret(env, user, store.label, store.secret, true);
    const userMessage = await message(env, { personId: user.person_id, role: 'user', text: `Saved a password for ${store.label} to Private Vault.` });
    const reply = 'Saved securely in Private Vault.';
    await message(env, { role: 'assistant', text: reply, replyTo: userMessage.id });
    return json({ ok: true, reply, vault_saved: { label: store.label } });
  }

  if (get?.label) {
    const row = await findSecret(env, get.label);
    const userMessage = await message(env, { personId: user.person_id, role: 'user', text: `Asked Private Vault for the password to ${get.label}.` });
    if (!row) {
      const reply = `I could not find a password saved for ${get.label} in Private Vault.`;
      await message(env, { role: 'assistant', text: reply, replyTo: userMessage.id });
      return json({ ok: true, reply });
    }
    const secret = await decryptSecret(env, row);
    const t = now();
    await env.DB.prepare('UPDATE vault_secrets SET last_accessed_at=? WHERE id=?').bind(t, row.id).run();
    await audit(env, user, row.id, 'reveal');
    const reply = `I found the password for ${row.label} in Private Vault.`;
    await message(env, { role: 'assistant', text: `${reply} Reveal was shown only on this device.`, replyTo: userMessage.id });
    return json({ ok: true, reply, vault_reveal: { id: row.id, label: row.label, secret } });
  }
  return null;
}

export async function listVault(env, user) {
  if (user.role !== 'owner') return json({ error: 'Private Vault is owner-only' }, 403);
  const rows = (await env.DB.prepare('SELECT id,label,username,created_at,updated_at,last_accessed_at FROM vault_secrets ORDER BY label COLLATE NOCASE').all()).results || [];
  return json({ configured: !!env.VAULT_MASTER_KEY, items: rows });
}

export async function revealVault(env, user, id) {
  if (user.role !== 'owner') return json({ error: 'Private Vault is owner-only' }, 403);
  const row = await env.DB.prepare('SELECT * FROM vault_secrets WHERE id=?').bind(id).first();
  if (!row) return json({ error: 'Vault item not found' }, 404);
  const secret = await decryptSecret(env, row);
  await env.DB.prepare('UPDATE vault_secrets SET last_accessed_at=? WHERE id=?').bind(now(), id).run();
  await audit(env, user, id, 'reveal');
  return json({ id, label: row.label, secret });
}

export async function deleteVault(env, user, id) {
  if (user.role !== 'owner') return json({ error: 'Private Vault is owner-only' }, 403);
  const row = await env.DB.prepare('SELECT id,label FROM vault_secrets WHERE id=?').bind(id).first();
  if (!row) return json({ error: 'Vault item not found' }, 404);
  await audit(env, user, id, 'delete');
  await env.DB.prepare('DELETE FROM vault_secrets WHERE id=?').bind(id).run();
  return json({ ok: true, deleted: row.label });
}

export async function migrateLegacyVault(env, user) {
  if (user?.role !== 'owner' || !env.VAULT_MASTER_KEY || String(env.VAULT_MASTER_KEY).length < 32) return { migrated: 0 };
  const rows = (await env.DB.prepare("SELECT id,text FROM messages WHERE person_id=? AND role='user' AND LOWER(text) LIKE '%password%' ORDER BY created_at ASC LIMIT 300").bind(user.person_id).all()).results || [];
  let migrated = 0;
  for (const row of rows) {
    const parsed = detectVaultStore(row.text);
    if (!parsed?.secret || parsed.blocked) continue;
    const existing = await env.DB.prepare('SELECT id FROM vault_secrets WHERE label_norm=? LIMIT 1').bind(norm(parsed.label)).first();
    if (!existing) await putSecret(env, user, parsed.label, parsed.secret, false);
    const redacted = `Password for ${parsed.label} was moved to Private Vault.`;
    await env.DB.prepare('UPDATE messages SET text=? WHERE id=?').bind(redacted, row.id).run();
    await env.DB.prepare("UPDATE messages SET text='Saved securely in Private Vault.' WHERE reply_to=? AND role='assistant'").bind(row.id).run();
    migrated++;
  }
  return { migrated };
}
