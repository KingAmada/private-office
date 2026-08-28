import core from './index.js';
import { ensure, auth, role, message } from './db.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
});

const origins = env => String(env.APP_ORIGINS || 'https://kingamada.github.io')
  .split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean);

function cors(req, env) {
  const origin = (req.headers.get('Origin') || '').replace(/\/$/, '');
  const allowed = origins(env);
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || 'null',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function wrap(res, req, env) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors(req, env))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

const retrievalIntent = text => /^(get|send|bring|show|find|give)\b/i.test(String(text || '').trim()) &&
  /\b(file|document|photo|image|screenshot|sheet|spreadsheet|pdf|quotation|agreement|statement|letter|report)\b/i.test(String(text || ''));

function terms(text) {
  const stop = new Set([
    'get','send','bring','show','find','give','me','my','i','the','a','an','of','that','this','to','for','from','with','and',
    'file','document','photo','image','screenshot','sheet','spreadsheet','pdf','uploaded','upload','sent','send','added','add','please'
  ]);
  return [...new Set(String(text || '').toLowerCase().match(/[a-z0-9]{2,}/g) || [])]
    .filter(x => !stop.has(x)).slice(0, 8);
}

function score(file, words) {
  const hay = [file.stored_name,file.original_name,file.title,file.category,file.document_type,file.summary,file.search_text,file.entity_name,file.created_by_name]
    .filter(Boolean).join(' ').toLowerCase();
  return words.reduce((n, word) => n + (hay.includes(word) ? 3 : 0), 0);
}

async function retrieve(req, env, user, text) {
  const mineOnly = /\b(i|my)\b.{0,24}\b(uploaded|sent|added)\b/i.test(text);
  const staffOnly = user.role === 'staff' || mineOnly;
  const sql = `
    SELECT f.*, p.name created_by_name
    FROM files f LEFT JOIN people p ON p.id=f.created_by
    ${staffOnly ? 'WHERE f.created_by=?' : ''}
    ORDER BY f.created_at DESC LIMIT 150`;
  const rows = (staffOnly
    ? await env.DB.prepare(sql).bind(user.person_id).all()
    : await env.DB.prepare(sql).all()).results || [];
  const words = terms(text);
  const ranked = rows.map(f => ({ f, score: score(f, words) }))
    .filter(x => words.length ? x.score > 0 : true)
    .sort((a, b) => b.score - a.score || String(b.f.created_at).localeCompare(String(a.f.created_at)));
  const found = ranked[0]?.f || null;

  const userMessage = await message(env, { personId: user.person_id, role: 'user', text });
  let reply = 'I could not find a matching file in Private Office.';
  if (found) {
    reply = `Here it is: “${found.stored_name || found.title || found.original_name}”.`;
    await message(env, {
      role: 'assistant', text: reply, fileId: found.id,
      visibleTo: user.role === 'staff' ? user.person_id : null,
      replyTo: userMessage.id
    });
  } else {
    await message(env, {
      role: 'assistant', text: reply,
      visibleTo: user.role === 'staff' ? user.person_id : null,
      replyTo: userMessage.id
    });
  }
  return json({ ok: true, reply, file_id: found?.id || null });
}

async function removeFile(env, user, id) {
  role(user, ['owner']);
  const file = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(id).first();
  if (!file) return json({ error: 'File not found' }, 404);

  await env.FILES.delete(file.r2_key);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE file_id=? AND TRIM(COALESCE(text,''))='' ").bind(id),
    env.DB.prepare('UPDATE messages SET file_id=NULL WHERE file_id=?').bind(id),
    env.DB.prepare('DELETE FROM files WHERE id=?').bind(id)
  ]);
  await message(env, { role: 'system', text: `${user.name || 'Owner'} deleted “${file.stored_name || file.original_name}”.` });
  return json({ ok: true, deleted: { id, name: file.stored_name || file.original_name } });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
    try {
      await ensure(env);
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === 'DELETE' && path.startsWith('/api/files/')) {
        const user = await auth(req, env);
        if (!user) return wrap(json({ error: 'Private session required' }, 401), req, env);
        const id = decodeURIComponent(path.slice('/api/files/'.length));
        return wrap(await removeFile(env, user, id), req, env);
      }

      if (req.method === 'POST' && path === '/api/message') {
        const clone = req.clone();
        const fd = await clone.formData();
        const text = String(fd.get('text') || '').trim();
        const upload = fd.get('file');
        if (!(upload instanceof File && upload.size) && retrievalIntent(text)) {
          const user = await auth(req, env);
          if (!user) return wrap(json({ error: 'Private session required' }, 401), req, env);
          return wrap(await retrieve(req, env, user, text), req, env);
        }
      }

      return core.fetch(req, env);
    } catch (e) {
      return wrap(json({ error: e?.message || 'Private Office error' }, e?.status || 500), req, env);
    }
  }
};
