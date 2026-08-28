import { classifyMetadata } from './ai.js';
import { uid, now, message } from './db.js';

const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_SIZE = 5 * 1024 * 1024 * 1024;

const safe = s => String(s || 'Document')
  .replace(/[\\/:*?"<>|\u0000-\u001F]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim().slice(0, 120) || 'Document';
const ext = n => (String(n || '').match(/(\.[A-Za-z0-9]{1,8})$/) || ['', ''])[1].toLowerCase();
const base = n => ext(n) ? String(n).slice(0, -ext(n).length) : String(n || 'Document');
const filename = (orig, want) => `${safe(base(want || orig)).replace(/^[-_. ]+|[-_. ]+$/g, '').slice(0, 100) || 'Document'}${ext(orig)}`;
const segment = s => safe(s || 'Other').replace(/\.+$/g, '').trim() || 'Other';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

function folderPath(c) {
  const parts = [segment(c.category || 'Other')];
  if (c.entity_name) parts.push(segment(c.entity_name));
  parts.push(segment(c.document_type || 'Documents'));
  return parts.join('/');
}

function fallback(name, mime, note) {
  const lower = `${name} ${note}`.toLowerCase();
  let category = 'Other', document_type = mime?.startsWith('image/') ? 'Image' : 'Document';
  if (/quotation|quote|inventory|stock|supplier|procurement|purchase order/.test(lower)) category = 'Operations';
  else if (/company|cac|incorporat|rc no|memorandum|articles/.test(lower)) category = 'Companies';
  else if (/property|land|allocation|title|c of o|certificate of occupancy|lease/.test(lower)) category = 'Properties';
  else if (/agreement|nda|legal|contract/.test(lower)) category = 'Legal';
  else if (/statement|bank|account/.test(lower)) category = 'Banking';
  return {
    suggested_filename: name,
    document_type,
    category,
    title: base(name),
    summary: 'Large original stored. Filing is based on filename and uploader context.',
    search_text: `${name} ${note}`.slice(0, 1200),
    entity_name: null,
    document_date: null,
    expiry_date: null
  };
}

async function getUpload(env, id, user) {
  const row = await env.DB.prepare('SELECT * FROM multipart_uploads WHERE id=?').bind(id).first();
  if (!row) return null;
  if (row.created_by !== user.person_id && user.role !== 'owner') return 'forbidden';
  return row;
}

export async function initMultipart(req, env, user) {
  const body = await req.json();
  const original = safe(body.name || 'Document');
  const mime = String(body.mime || 'application/octet-stream').slice(0, 160);
  const size = Number(body.size || 0);
  const note = String(body.note || '').trim().slice(0, 30000);
  if (!Number.isFinite(size) || size <= 0) return json({ error: 'Invalid file size' }, 400);
  if (size > MAX_SIZE) return json({ error: 'This file is larger than the 5 GB Private Office upload limit.' }, 413);

  let c;
  try { c = await classifyMetadata(env, { name: original, mime, size, note }); }
  catch { c = fallback(original, mime, note); }

  const id = uid();
  const stored = filename(original, c.suggested_filename || c.title || original);
  const key = `${folderPath(c)}/${id}-${stored}`;
  const mp = await env.FILES.createMultipartUpload(key, {
    httpMetadata: { contentType: mime },
    customMetadata: { original_name: original, uploaded_by: user.person_id }
  });
  const t = now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO multipart_uploads(id,upload_id,r2_key,original_name,mime,size,note,created_by,created_at,status)
      VALUES(?,?,?,?,?,?,?,?,?,'uploading')`).bind(id, mp.uploadId, key, original, mime, size, note, user.person_id, t),
    env.DB.prepare('INSERT OR REPLACE INTO multipart_upload_meta(id,data) VALUES(?,?)').bind(id, JSON.stringify({ ...c, stored_name: stored }))
  ]);

  return json({
    ok: true,
    id,
    chunk_size: CHUNK_SIZE,
    file: { name: stored, size, mime, category: c.category || 'Other', document_type: c.document_type || 'Document', entity_name: c.entity_name || null }
  });
}

export async function uploadMultipartPart(req, env, user, id, partNumber) {
  const row = await getUpload(env, id, user);
  if (!row) return json({ error: 'Upload session not found' }, 404);
  if (row === 'forbidden') return json({ error: 'Not authorized for this upload' }, 403);
  const n = Number(partNumber);
  if (!Number.isInteger(n) || n < 1 || n > 10000) return json({ error: 'Invalid part number' }, 400);
  if (!req.body) return json({ error: 'Upload part is empty' }, 400);
  const mp = env.FILES.resumeMultipartUpload(row.r2_key, row.upload_id);
  const part = await mp.uploadPart(n, req.body);
  return json({ ok: true, part: { partNumber: part.partNumber, etag: part.etag } });
}

export async function completeMultipart(req, env, user, id) {
  const row = await getUpload(env, id, user);
  if (!row) return json({ error: 'Upload session not found' }, 404);
  if (row === 'forbidden') return json({ error: 'Not authorized for this upload' }, 403);
  const body = await req.json();
  const parts = Array.isArray(body.parts) ? body.parts
    .map(p => ({ partNumber: Number(p.partNumber), etag: String(p.etag || '') }))
    .filter(p => Number.isInteger(p.partNumber) && p.partNumber > 0 && p.etag) : [];
  if (!parts.length) return json({ error: 'No uploaded parts were supplied' }, 400);
  parts.sort((a,b) => a.partNumber - b.partNumber);

  const mp = env.FILES.resumeMultipartUpload(row.r2_key, row.upload_id);
  const object = await mp.complete(parts);
  const metaRow = await env.DB.prepare('SELECT data FROM multipart_upload_meta WHERE id=?').bind(id).first();
  let c = {};
  try { c = JSON.parse(metaRow?.data || '{}'); } catch {}
  const stored = safe(c.stored_name || row.original_name);
  const t = now();
  const searchText = [c.search_text, row.note].filter(Boolean).join(' ').slice(0, 1600);

  await env.DB.prepare(`INSERT INTO files(id,r2_key,original_name,stored_name,mime,size,sha256,category,document_type,title,summary,search_text,entity_name,document_date,expiry_date,created_by,created_at,ai_used)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      id,row.r2_key,row.original_name,stored,row.mime,Number(object?.size || row.size),`multipart:${id}`,
      c.category || 'Other',c.document_type || 'Document',c.title || base(row.original_name),c.summary || 'Large original stored.',searchText,
      c.entity_name || null,c.document_date || null,c.expiry_date || null,row.created_by,t,2
    ).run();

  const userMessage = await message(env, { personId: row.created_by, role: 'user', text: row.note, fileId: id });
  const reply = `Remembered. I filed it as “${stored}” under ${c.category || 'Other'}${c.entity_name ? ` → ${c.entity_name}` : ''}.`;
  await message(env, { role: 'assistant', text: reply, visibleTo: user.role === 'staff' ? user.person_id : null, replyTo: userMessage.id });
  await env.DB.batch([
    env.DB.prepare("UPDATE multipart_uploads SET status='complete' WHERE id=?").bind(id),
    env.DB.prepare('DELETE FROM multipart_upload_meta WHERE id=?').bind(id)
  ]);

  return json({
    ok: true,
    reply,
    file: {
      id,name: stored,original_name: row.original_name,mime: row.mime,size: Number(object?.size || row.size),
      category: c.category || 'Other',document_type: c.document_type || 'Document',title: c.title || base(row.original_name),
      summary: c.summary || 'Large original stored.',entity_name: c.entity_name || null,created_at: t,ai_used: 2
    }
  });
}

export async function abortMultipart(env, user, id) {
  const row = await getUpload(env, id, user);
  if (!row) return json({ ok: true });
  if (row === 'forbidden') return json({ error: 'Not authorized for this upload' }, 403);
  try { await env.FILES.resumeMultipartUpload(row.r2_key, row.upload_id).abort(); } catch {}
  await env.DB.batch([
    env.DB.prepare('DELETE FROM multipart_uploads WHERE id=?').bind(id),
    env.DB.prepare('DELETE FROM multipart_upload_meta WHERE id=?').bind(id)
  ]);
  return json({ ok: true });
}
