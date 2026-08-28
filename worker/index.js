import { ensure, auth, role, session, message, hash, token, uid, now, plusDays, INVITE_DAYS } from './db.js';
import { classify, answer } from './ai.js';

const MAX = 12 * 1024 * 1024;

const safe = s => String(s || 'Document')
  .replace(/[\\/:*?"<>|\u0000-\u001F]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120) || 'Document';

const ext = n => (String(n || '').match(/(\.[A-Za-z0-9]{1,8})$/) || ['', ''])[1].toLowerCase();
const base = n => ext(n) ? String(n).slice(0, -ext(n).length) : String(n || 'Document');
const filename = (orig, want) => `${safe(base(want || orig)).replace(/^[-_. ]+|[-_. ]+$/g, '').slice(0, 105) || 'Document'}${ext(orig)}`;
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

const origins = env => String(env.APP_ORIGINS || 'https://kingamada.github.io')
  .split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean);

function cors(req, env) {
  const origin = (req.headers.get('Origin') || '').replace(/\/$/, '');
  const allowed = origins(env);
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || 'null',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function wrap(res, req, env) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors(req, env))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

const isQuestion = t => /\?$/.test(String(t).trim()) || /^(what|where|when|who|which|how|why|find|show|tell|do i|did i|have i|is there|are there|can you|give me|bring me)\b/i.test(String(t).trim());
const recentIntent = q => /\b(just|last|latest|newest|recent|recently|today|this morning|this afternoon|this evening|uploaded|upload|sent|send|added|add)\b/i.test(String(q || ''));
const directLatestFileQuestion = q => {
  const s = String(q || '').trim();
  return /\b(what|which|show|find|give|bring)\b.*\b(file|document|photo|image|thing)\b.*\b(just|last|latest|newest|recent|uploaded|sent|added)\b/i.test(s) ||
    /\bwhat\s+(?:did\s+i\s+)?(?:just\s+)?(?:upload|send|add)\b/i.test(s) ||
    /\bwhat\s+(?:was|is)\s+(?:the\s+)?(?:last|latest|newest|most\s+recent)\s+(?:file|document|photo|image|thing\s+)?(?:uploaded|sent|added)?\b/i.test(s) ||
    /\bwhat\s+was\s+last\s+(?:uploaded|sent|added)\b/i.test(s);
};

function searchTerms(q) {
  const stop = new Set([
    'what','where','when','who','which','how','why','find','show','tell','give','bring','can','could','would','should',
    'do','did','does','have','has','had','is','are','was','were','me','my','i','the','a','an','about','of','to','in','on',
    'for','from','with','documents','document','files','file','records','record','memory','please'
  ]);
  return [...new Set(String(q || '').toLowerCase().match(/[a-z0-9]{2,}/g) || [])]
    .filter(x => !stop.has(x)).slice(0, 7);
}

function scoreRow(row, terms) {
  if (!terms.length) return 1;
  const hay = [row.stored_name,row.original_name,row.title,row.category,row.document_type,row.summary,row.search_text,row.entity_name,row.created_by_name,row.text,row.person]
    .filter(Boolean).join(' ').toLowerCase();
  return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
}

async function memory(env, user, q) {
  const recent = recentIntent(q);
  const terms = searchTerms(q);
  const staff = user.role === 'staff';
  let files = [];
  let msgs = [];

  if (recent || !terms.length) {
    const fileSql = `
      SELECT f.id,f.r2_key,f.original_name,f.stored_name,f.mime,f.size,f.category,f.document_type,f.title,
             f.summary,f.search_text,f.entity_name,f.document_date,f.expiry_date,f.created_by,f.created_at,f.ai_used,
             p.name created_by_name
      FROM files f LEFT JOIN people p ON p.id=f.created_by
      ${staff ? 'WHERE f.created_by=?' : ''}
      ORDER BY f.created_at DESC LIMIT 8`;
    files = (staff
      ? await env.DB.prepare(fileSql).bind(user.person_id).all()
      : await env.DB.prepare(fileSql).all()).results || [];

    const msgSql = `
      SELECT m.text,m.created_at,m.person_id,p.name person
      FROM messages m LEFT JOIN people p ON p.id=m.person_id
      ${staff ? 'WHERE m.person_id=?' : ''}
      ORDER BY m.created_at DESC LIMIT 10`;
    msgs = (staff
      ? await env.DB.prepare(msgSql).bind(user.person_id).all()
      : await env.DB.prepare(msgSql).all()).results || [];
  } else {
    const fileGroup = terms.map(() => '(f.stored_name LIKE ? OR f.original_name LIKE ? OR f.title LIKE ? OR f.summary LIKE ? OR f.search_text LIKE ? OR f.entity_name LIKE ? OR p.name LIKE ?)').join(' OR ');
    const fileArgs = terms.flatMap(t => Array(7).fill(`%${t}%`));
    if (staff) fileArgs.push(user.person_id);
    const fileSql = `
      SELECT f.id,f.r2_key,f.original_name,f.stored_name,f.mime,f.size,f.category,f.document_type,f.title,
             f.summary,f.search_text,f.entity_name,f.document_date,f.expiry_date,f.created_by,f.created_at,f.ai_used,
             p.name created_by_name
      FROM files f LEFT JOIN people p ON p.id=f.created_by
      WHERE (${fileGroup}) ${staff ? 'AND f.created_by=?' : ''}
      ORDER BY f.created_at DESC LIMIT 24`;
    files = (await env.DB.prepare(fileSql).bind(...fileArgs).all()).results || [];

    const msgGroup = terms.map(() => '(m.text LIKE ? OR p.name LIKE ?)').join(' OR ');
    const msgArgs = terms.flatMap(t => [`%${t}%`, `%${t}%`]);
    if (staff) msgArgs.push(user.person_id);
    const msgSql = `
      SELECT m.text,m.created_at,m.person_id,p.name person
      FROM messages m LEFT JOIN people p ON p.id=m.person_id
      WHERE (${msgGroup}) ${staff ? 'AND m.person_id=?' : ''}
      ORDER BY m.created_at DESC LIMIT 24`;
    msgs = (await env.DB.prepare(msgSql).bind(...msgArgs).all()).results || [];
  }

  const fileRows = files.map(x => ({ kind: 'file', ...x, _score: scoreRow(x, terms) }));
  const msgRows = msgs.map(x => ({ kind: 'message', text: x.text, created_at: x.created_at, person: x.person || 'Private Office', _score: scoreRow(x, terms) }));

  if (recent) {
    return [...fileRows, ...msgRows]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 12)
      .map(({ _score, ...x }) => x);
  }

  return [...fileRows, ...msgRows]
    .filter(x => x._score > 0)
    .sort((a, b) => b._score - a._score || String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 10)
    .map(({ _score, ...x }) => x);
}

async function fileObj(env, f) {
  return f ? {
    id: f.id,
    name: f.stored_name,
    original_name: f.original_name,
    mime: f.mime,
    size: f.size,
    category: f.category,
    document_type: f.document_type,
    title: f.title,
    summary: f.summary,
    entity_name: f.entity_name,
    created_at: f.created_at,
    ai_used: Number(f.ai_used || 0)
  } : null;
}

function objectKey(id, stored, category, entity) {
  const cat = safe(category || 'Other');
  const ent = entity ? `${safe(entity)}/` : '';
  return `${cat}/${ent}${new Date().toISOString().slice(0,10)}/${id}-${stored}`;
}

async function repairClassification(env, row, providedBytes = null) {
  if (!row || Number(row.ai_used) === 1) return row;
  let bytes = providedBytes;
  if (!bytes) {
    const object = await env.FILES.get(row.r2_key);
    if (!object) return row;
    bytes = await object.arrayBuffer();
  }

  const file = new File([bytes], row.original_name || row.stored_name || 'document', { type: row.mime || 'application/octet-stream' });
  const c = await classify(env, bytes, file);
  const stored = filename(row.original_name, c.suggested_filename || c.title || row.original_name);
  const newKey = objectKey(row.id, stored, c.category, c.entity_name);

  if (newKey !== row.r2_key) {
    await env.FILES.put(newKey, bytes, {
      httpMetadata: { contentType: row.mime || 'application/octet-stream' },
      customMetadata: { original_name: safe(row.original_name), uploaded_by: row.created_by }
    });
    await env.FILES.delete(row.r2_key);
  }

  await env.DB.prepare(`
    UPDATE files SET r2_key=?,stored_name=?,category=?,document_type=?,title=?,summary=?,search_text=?,entity_name=?,document_date=?,expiry_date=?,ai_used=1
    WHERE id=?`)
    .bind(
      newKey, stored, c.category || 'Other', c.document_type || 'Document', c.title || base(row.original_name),
      c.summary || '', c.search_text || row.search_text || row.original_name, c.entity_name || null,
      c.document_date || null, c.expiry_date || null, row.id
    ).run();

  return await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(row.id).first();
}

async function repairStoredFile(env, user, id) {
  let row = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(id).first();
  if (!row) return json({ error: 'File not found' }, 404);
  if (user.role === 'staff' && row.created_by !== user.person_id) return json({ error: 'Not authorized for this file' }, 403);
  if (Number(row.ai_used) === 1) return json({ ok: true, already_classified: true, file: await fileObj(env, row) });
  row = await repairClassification(env, row);
  return json({ ok: true, file: await fileObj(env, row) });
}

async function bootstrap(req, env) {
  if (!env.SETUP_KEY) return json({ error: 'SETUP_KEY secret is not configured' }, 503);
  const body = await req.json();
  if (String(body.setup_key || '') !== String(env.SETUP_KEY)) return json({ error: 'Invalid setup key' }, 403);
  if (await env.DB.prepare("SELECT id FROM people WHERE role='owner' AND active=1 LIMIT 1").first()) return json({ error: 'Owner access already exists' }, 409);
  const personId = uid(), t = now(), name = safe(body.name || 'Owner');
  await env.DB.prepare("INSERT INTO people(id,name,role,active,created_at) VALUES(?,?,'owner',1,?)").bind(personId, name, t).run();
  const sessionToken = await session(env, personId, body.device_label || 'Owner device');
  await message(env, { role: 'system', text: `${name} created Private Office.` });
  return json({ session_token: sessionToken, person: { id: personId, name, role: 'owner' } });
}

async function acceptInvite(req, env) {
  const body = await req.json(), h = await hash(body.token || '');
  const x = await env.DB.prepare(`
    SELECT i.id,i.person_id,i.expires_at,i.revoked_at,p.name,p.role,p.active
    FROM invites i JOIN people p ON p.id=i.person_id WHERE i.token_hash=? LIMIT 1`).bind(h).first();
  if (!x || x.revoked_at || !x.active || (x.expires_at && Date.parse(x.expires_at) <= Date.now())) return json({ error: 'This private link is invalid, expired or revoked' }, 403);
  const sessionToken = await session(env, x.person_id, body.device_label || 'Private Office device');
  await env.DB.prepare('UPDATE invites SET use_count=use_count+1 WHERE id=?').bind(x.id).run();
  return json({ session_token: sessionToken, person: { id: x.person_id, name: x.name, role: x.role } });
}

async function feed(env, user) {
  const where = user.role === 'staff' ? 'WHERE (m.person_id=? OR m.visible_to_person_id=?)' : '';
  const st = env.DB.prepare(`
    SELECT m.id,m.role,m.text,m.created_at,m.person_id,m.file_id,p.name person_name,
           f.stored_name,f.original_name,f.mime,f.size,f.category,f.document_type,f.title,f.summary,f.entity_name,f.created_at file_created_at,f.ai_used
    FROM messages m LEFT JOIN people p ON p.id=m.person_id LEFT JOIN files f ON f.id=m.file_id
    ${where} ORDER BY m.created_at DESC LIMIT 120`);
  const rows = (user.role === 'staff' ? await st.bind(user.person_id, user.person_id).all() : await st.all()).results || [];
  return json({ messages: rows.reverse().map(x => ({
    id: x.id, role: x.role, text: x.text, created_at: x.created_at,
    person: x.person_name || (x.role === 'assistant' ? 'Private Office' : 'System'),
    file: x.file_id ? {
      id: x.file_id, name: x.stored_name, original_name: x.original_name, mime: x.mime, size: x.size,
      category: x.category, document_type: x.document_type, title: x.title, summary: x.summary,
      entity_name: x.entity_name, created_at: x.file_created_at, ai_used: Number(x.ai_used || 0)
    } : null
  })) });
}

async function send(req, env, user) {
  const fd = await req.formData();
  const text = String(fd.get('text') || '').trim().slice(0, 30000);
  const upload = fd.get('file');
  if (!text && !(upload instanceof File && upload.size)) return json({ error: 'Write a message or attach a file' }, 400);

  let fileRow = null, fileId = null, duplicate = false;

  if (upload instanceof File && upload.size) {
    if (upload.size > MAX) return json({ error: 'File is too large. Maximum is 12 MB.' }, 413);
    const bytes = await upload.arrayBuffer();
    const sha = await hash(bytes);
    fileRow = await env.DB.prepare('SELECT * FROM files WHERE sha256=? LIMIT 1').bind(sha).first();

    if (fileRow) {
      fileId = fileRow.id;
      duplicate = true;
      if (Number(fileRow.ai_used) === 0) {
        try { fileRow = await repairClassification(env, fileRow, bytes); } catch (e) { console.log('classification retry failed', e.message); }
      }
    } else {
      let c;
      try {
        c = await classify(env, bytes, upload);
      } catch (e) {
        console.log('classification failed', e.message);
        c = {
          suggested_filename: upload.name,
          document_type: upload.type?.startsWith('image/') ? 'Image' : 'Document',
          category: 'Other',
          title: base(upload.name),
          summary: 'Stored safely. AI classification can be retried later.',
          search_text: `${upload.name} ${text}`,
          entity_name: null,
          document_date: null,
          expiry_date: null
        };
      }

      fileId = uid();
      const stored = filename(upload.name, c.suggested_filename || c.title || upload.name);
      const key = objectKey(fileId, stored, c.category, c.entity_name);
      await env.FILES.put(key, bytes, {
        httpMetadata: { contentType: upload.type || 'application/octet-stream' },
        customMetadata: { original_name: safe(upload.name), uploaded_by: user.person_id }
      });
      const t = now();
      const searchText = [c.search_text, text].filter(Boolean).join(' ').slice(0, 1600);
      await env.DB.prepare(`
        INSERT INTO files(id,r2_key,original_name,stored_name,mime,size,sha256,category,document_type,title,summary,search_text,entity_name,document_date,expiry_date,created_by,created_at,ai_used)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(
          fileId,key,safe(upload.name),stored,upload.type || 'application/octet-stream',upload.size,sha,
          c.category || 'Other',c.document_type || 'Document',c.title || base(upload.name),c.summary || '',searchText,
          c.entity_name || null,c.document_date || null,c.expiry_date || null,user.person_id,t,
          c.summary?.startsWith('Stored safely') ? 0 : 1
        ).run();
      fileRow = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(fileId).first();
    }
  }

  let reply = 'Remembered.';
  let sourceFileId = null;

  if (fileRow) {
    reply = duplicate
      ? `Remembered. This is the same file already stored as “${fileRow.stored_name}”. I linked this new message to it.`
      : `Remembered. I filed it as “${fileRow.stored_name}” under ${fileRow.category || 'Other'}${fileRow.entity_name ? ` → ${fileRow.entity_name}` : ''}.`;
  } else if (isQuestion(text)) {
    let context = await memory(env, user, text);

    if (directLatestFileQuestion(text)) {
      let latest = context.find(x => x.kind === 'file');
      if (latest) {
        if (Number(latest.ai_used) === 0) {
          try {
            const full = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(latest.id).first();
            const repaired = await repairClassification(env, full);
            latest = { ...latest, ...repaired, kind: 'file' };
          } catch (e) { console.log('recent file repair failed', e.message); }
        }
        sourceFileId = latest.id;
        reply = `The last file uploaded was “${latest.stored_name || latest.original_name || latest.title}”${latest.document_type ? ` (${latest.document_type})` : ''}${latest.created_by_name ? `, uploaded by ${latest.created_by_name}` : ''}.`;
      } else {
        reply = 'I could not find a recent uploaded file in Private Office.';
      }
    } else {
      reply = await answer(env, text, context);
      sourceFileId = context.find(x => x.kind === 'file')?.id || null;
    }
  }

  const userMessage = await message(env, { personId: user.person_id, role: 'user', text, fileId });
  await message(env, {
    role: 'assistant', text: reply,
    fileId: fileRow ? null : sourceFileId,
    visibleTo: user.role === 'staff' ? user.person_id : null,
    replyTo: userMessage.id
  });
  return json({ ok: true, reply, file: await fileObj(env, fileRow) });
}

async function library(env, user, url) {
  const q = (url.searchParams.get('q') || '').trim(), clauses = [], args = [];
  if (user.role === 'staff') { clauses.push('created_by=?'); args.push(user.person_id); }
  if (q) {
    const x = `%${q}%`;
    clauses.push('(stored_name LIKE ? OR title LIKE ? OR summary LIKE ? OR entity_name LIKE ? OR category LIKE ?)');
    args.push(x,x,x,x,x);
  }
  let sql = 'SELECT id,original_name,stored_name,mime,size,category,document_type,title,summary,entity_name,created_at,created_by,ai_used FROM files';
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT 150';
  return json({ files: (await env.DB.prepare(sql).bind(...args).all()).results || [] });
}

async function download(env, user, id) {
  const f = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(id).first();
  if (!f) return json({ error: 'File not found' }, 404);
  if (user.role === 'staff' && f.created_by !== user.person_id) return json({ error: 'Not authorized for this file' }, 403);
  const object = await env.FILES.get(f.r2_key);
  if (!object) return json({ error: 'Stored object is missing' }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', f.mime || headers.get('Content-Type') || 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.stored_name)}`);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(object.body, { headers });
}

async function people(env, user) {
  role(user, ['owner']);
  const t = now();
  return json({ people: (await env.DB.prepare(`
    SELECT p.id,p.name,p.role,p.active,p.created_at,
      (SELECT COUNT(*) FROM sessions s WHERE s.person_id=p.id AND s.revoked_at IS NULL AND s.expires_at>?) sessions
    FROM people p ORDER BY p.created_at`).bind(t).all()).results || [] });
}

async function invite(req, env, user) {
  role(user, ['owner']);
  const body = await req.json();
  const userRole = ['assistant','staff'].includes(body.role) ? body.role : 'staff';
  const name = safe(body.name || 'Staff'), personId = uid(), inviteId = uid(), raw = token(32), t = now();
  await env.DB.prepare('INSERT INTO people(id,name,role,active,created_at) VALUES(?,?,?,1,?)').bind(personId,name,userRole,t).run();
  await env.DB.prepare('INSERT INTO invites(id,person_id,token_hash,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .bind(inviteId,personId,await hash(raw),user.person_id,t,plusDays(Number(body.expires_days || INVITE_DAYS))).run();
  const appBase = String(env.APP_URL || 'https://kingamada.github.io/private-office/').replace(/\?.*$/, '');
  return json({ invite: { id: inviteId, person_id: personId, name, role: userRole, url: `${appBase}?invite=${encodeURIComponent(raw)}` } });
}

async function revoke(req, env, user) {
  role(user, ['owner']);
  const body = await req.json(), personId = String(body.person_id || '');
  if (!personId || personId === user.person_id) return json({ error: 'You cannot revoke your own owner session here' }, 400);
  const t = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE people SET active=0 WHERE id=?').bind(personId),
    env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE person_id=? AND revoked_at IS NULL').bind(t,personId),
    env.DB.prepare('UPDATE invites SET revoked_at=? WHERE person_id=? AND revoked_at IS NULL').bind(t,personId)
  ]);
  return json({ ok: true });
}

async function route(req, env) {
  await ensure(env);
  const url = new URL(req.url), path = url.pathname;
  if (req.method === 'GET' && (path === '/' || path === '/api/health')) return json({ ok: true, service: 'Private Office', storage: !!env.FILES, database: !!env.DB });
  if (req.method === 'POST' && path === '/api/bootstrap') return bootstrap(req, env);
  if (req.method === 'POST' && path === '/api/invite/accept') return acceptInvite(req, env);

  const me = await auth(req, env);
  if (!me) return json({ error: 'Private session required' }, 401);
  if (req.method === 'GET' && path === '/api/me') return json({ person: { id: me.person_id, name: me.name, role: me.role } });
  if (req.method === 'GET' && path === '/api/feed') return feed(env, me);
  if (req.method === 'POST' && path === '/api/message') return send(req, env, me);
  if (req.method === 'GET' && path === '/api/library') return library(env, me, url);
  if (req.method === 'POST' && path.startsWith('/api/files/') && path.endsWith('/repair')) {
    const id = decodeURIComponent(path.slice('/api/files/'.length, -'/repair'.length));
    return repairStoredFile(env, me, id);
  }
  if (req.method === 'GET' && path.startsWith('/api/files/')) return download(env, me, decodeURIComponent(path.slice(11)));
  if (req.method === 'GET' && path === '/api/people') return people(env, me);
  if (req.method === 'POST' && path === '/api/invites') return invite(req, env, me);
  if (req.method === 'POST' && path === '/api/people/revoke') return revoke(req, env, me);
  if (req.method === 'POST' && path === '/api/logout') {
    await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').bind(now(), me.session_id).run();
    return json({ ok: true });
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
    try { return wrap(await route(req, env), req, env); }
    catch (e) { return wrap(json({ error: e?.message || 'Private Office error' }, e?.status || 500), req, env); }
  }
};
