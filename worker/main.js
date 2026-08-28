import core from './index.js';
import { classify } from './ai.js';
import { ensure, auth, role, message } from './db.js';
import { initMultipart, uploadMultipartPart, completeMultipart, abortMultipart } from './multipart.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
});

const safe = s => String(s || 'Documents')
  .replace(/[\\/:*?"<>|\u0000-\u001F]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim().slice(0, 110) || 'Documents';
const ext = n => (String(n || '').match(/(\.[A-Za-z0-9]{1,8})$/) || ['', ''])[1].toLowerCase();
const base = n => ext(n) ? String(n).slice(0, -ext(n).length) : String(n || 'Document');
const filename = (orig, want) => `${safe(base(want || orig)).replace(/^[-_. ]+|[-_. ]+$/g, '').slice(0, 100) || 'Document'}${ext(orig)}`;
const segment = s => safe(s || 'Other').replace(/\.+$/g, '').trim() || 'Other';

const origins = env => String(env.APP_ORIGINS || 'https://kingamada.github.io')
  .split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean);

function cors(req, env) {
  const origin = (req.headers.get('Origin') || '').replace(/\/$/, '');
  const allowed = origins(env);
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || 'null',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Disposition,Content-Type,Content-Length,X-File-Name',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function wrap(res, req, env) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors(req, env))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function folderParts(file) {
  const parts = [segment(file.category || 'Other')];
  if (file.entity_name) parts.push(segment(file.entity_name));
  parts.push(segment(file.document_type || 'Documents'));
  return parts;
}
function folderPath(file) { return folderParts(file).join('/'); }
function desiredKey(file) { return `${folderPath(file)}/${file.id}-${file.stored_name || file.original_name || 'Document'}`; }

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
  const sql = `SELECT f.*, p.name created_by_name FROM files f LEFT JOIN people p ON p.id=f.created_by
    ${staffOnly ? 'WHERE f.created_by=?' : ''} ORDER BY f.created_at DESC LIMIT 200`;
  const rows = (staffOnly ? await env.DB.prepare(sql).bind(user.person_id).all() : await env.DB.prepare(sql).all()).results || [];
  const words = terms(text);
  const ranked = rows.map(f => ({ f, score: score(f, words) }))
    .filter(x => words.length ? x.score > 0 : true)
    .sort((a, b) => b.score - a.score || String(b.f.created_at).localeCompare(String(a.f.created_at)));
  const found = ranked[0]?.f || null;
  const userMessage = await message(env, { personId: user.person_id, role: 'user', text });
  const reply = found ? `Here it is: “${found.stored_name || found.title || found.original_name}”.` : 'I could not find a matching file in Private Office.';
  await message(env, {
    role: 'assistant', text: reply, fileId: found?.id || null,
    visibleTo: user.role === 'staff' ? user.person_id : null, replyTo: userMessage.id
  });
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

async function workspace(env, user) {
  const staff = user.role === 'staff';
  const sql = `SELECT f.id,f.r2_key,f.original_name,f.stored_name,f.mime,f.size,f.category,f.document_type,f.title,
    f.summary,f.search_text,f.entity_name,f.document_date,f.expiry_date,f.created_by,f.created_at,f.ai_used,p.name created_by_name
    FROM files f LEFT JOIN people p ON p.id=f.created_by ${staff ? 'WHERE f.created_by=?' : ''}
    ORDER BY f.created_at DESC LIMIT 1000`;
  const files = (staff ? await env.DB.prepare(sql).bind(user.person_id).all() : await env.DB.prepare(sql).all()).results || [];
  const mapped = files.map(f => ({ ...f, size: Number(f.size || 0), ai_used: Number(f.ai_used || 0), folder_path: folderPath(f), folder_parts: folderParts(f) }));
  const categories = {}, entities = {}, types = {}, uploaders = {};
  let totalSize = 0, needsAI = 0;
  for (const f of mapped) {
    totalSize += f.size;
    if (!f.ai_used) needsAI++;
    categories[f.category || 'Other'] = (categories[f.category || 'Other'] || 0) + 1;
    types[f.document_type || 'Documents'] = (types[f.document_type || 'Documents'] || 0) + 1;
    if (f.entity_name) entities[f.entity_name] = (entities[f.entity_name] || 0) + 1;
    if (f.created_by_name) uploaders[f.created_by_name] = (uploaders[f.created_by_name] || 0) + 1;
  }
  return json({ files: mapped, stats: { total: mapped.length, total_size: totalSize, needs_ai: needsAI, categories, entities, types, uploaders }, can_organize: user.role === 'owner', can_delete: user.role === 'owner' });
}

async function moveObject(env, row, key) {
  if (!row.r2_key || row.r2_key === key) return false;
  const object = await env.FILES.get(row.r2_key);
  if (!object) return false;
  await env.FILES.put(key, object.body, { httpMetadata: object.httpMetadata, customMetadata: object.customMetadata });
  await env.FILES.delete(row.r2_key);
  await env.DB.prepare('UPDATE files SET r2_key=? WHERE id=?').bind(key, row.id).run();
  row.r2_key = key;
  return true;
}

async function normalizeStoredFile(env, id) {
  const row = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(id).first();
  if (!row) return false;
  return moveObject(env, row, desiredKey(row));
}

async function reclassify(env, row) {
  const object = await env.FILES.get(row.r2_key);
  if (!object) throw new Error(`Stored object missing for ${row.stored_name || row.original_name}`);
  const bytes = await object.arrayBuffer();
  const source = new File([bytes], row.original_name || row.stored_name || 'document', { type: row.mime || 'application/octet-stream' });
  const c = await classify(env, bytes, source);
  const stored = filename(row.original_name, c.suggested_filename || c.title || row.original_name);
  const updated = { ...row, stored_name: stored, category: c.category || 'Other', document_type: c.document_type || 'Document', title: c.title || base(row.original_name), summary: c.summary || '', search_text: c.search_text || row.search_text || row.original_name, entity_name: c.entity_name || null, document_date: c.document_date || null, expiry_date: c.expiry_date || null, ai_used: 1 };
  const key = desiredKey(updated);
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: row.mime || 'application/octet-stream' }, customMetadata: { original_name: safe(row.original_name), uploaded_by: row.created_by } });
  if (row.r2_key !== key) await env.FILES.delete(row.r2_key);
  await env.DB.prepare(`UPDATE files SET r2_key=?,stored_name=?,category=?,document_type=?,title=?,summary=?,search_text=?,entity_name=?,document_date=?,expiry_date=?,ai_used=1 WHERE id=?`)
    .bind(key,stored,updated.category,updated.document_type,updated.title,updated.summary,updated.search_text,updated.entity_name,updated.document_date,updated.expiry_date,row.id).run();
  return updated;
}

async function organize(req, env, user) {
  role(user, ['owner']);
  let body = {};
  try { body = await req.json(); } catch {}
  const deep = !!body.deep;
  const aiLimit = Math.max(0, Math.min(Number(body.max_ai || (deep ? 20 : 8)), deep ? 30 : 12));
  const rows = (await env.DB.prepare('SELECT * FROM files ORDER BY created_at DESC LIMIT 1000').all()).results || [];
  const report = { scanned: rows.length, moved: 0, reclassified: 0, renamed: 0, ai_reads: 0, skipped: 0, errors: [], examples: [] };
  for (const original of rows) {
    try {
      let row = { ...original };
      const needsAI = !Number(row.ai_used || 0);
      const shouldDeep = deep && Number(row.size || 0) < 50 * 1024 * 1024 && report.ai_reads < aiLimit;
      if ((needsAI || shouldDeep) && Number(row.size || 0) < 50 * 1024 * 1024 && report.ai_reads < aiLimit) {
        const beforeName = row.stored_name, beforeFolder = folderPath(row);
        row = await reclassify(env, row);
        report.ai_reads++; report.reclassified++;
        if (beforeName !== row.stored_name) report.renamed++;
        const afterFolder = folderPath(row);
        if (beforeFolder !== afterFolder || original.r2_key !== row.r2_key) report.moved++;
        if (report.examples.length < 8) report.examples.push({ from: beforeName, to: row.stored_name, folder: afterFolder });
        continue;
      }
      const key = desiredKey(row);
      if (await moveObject(env, row, key)) {
        report.moved++;
        if (report.examples.length < 8) report.examples.push({ from: row.stored_name, to: row.stored_name, folder: folderPath(row) });
      } else report.skipped++;
    } catch (e) { if (report.errors.length < 8) report.errors.push(String(e?.message || e)); }
  }
  await message(env, { role: 'system', text: `${user.name || 'Owner'} organized Private Office: ${report.moved} moved, ${report.reclassified} reclassified, ${report.ai_reads} AI reads.` });
  return json({ ok: true, report });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
    try {
      await ensure(env);
      const url = new URL(req.url), path = url.pathname;

      if (req.method === 'POST' && path === '/api/uploads/init') {
        const user = await auth(req, env);
        if (!user) return wrap(json({ error: 'Private session required' }, 401), req, env);
        return wrap(await initMultipart(req, env, user), req, env);
      }
      const partMatch = path.match(/^\/api\/uploads\/([^/]+)\/parts\/(\d+)$/);
      if (req.method === 'PUT' && partMatch) {
        const user = await auth(req, env);
        if (!user) return wrap(json({ error: 'Private session required' }, 401), req, env);
        return wrap(await uploadMultipartPart(req, env, user, decodeURIComponent(partMatch[1]), partMatch[2]), req, env);
      }
      const completeMatch = path.match(/^\/api\/uploads\/([^/]+)\/complete$/);
      if (req.method === 'POST' && completeMatch) {
        const user = await auth(req, env);
        if (!user) return wrap(json({ error: 'Private session required' }, 401), req, env);
        return wrap(await completeMultipart(req, env, user, decodeURIComponent(completeMatch[1])), req, env);
      }
      const uploadMatch = path.match(/^\/api\/uploads\/([^/]+)$/);
      if (req.method === 'DELETE' && uploadMatch) {
        const user = await auth(req, env);
        if (!user) return wrap(json({ error: 'Private session required' }, 401), req, env);
        return wrap(await abortMultipart(env, user, decodeURIComponent(uploadMatch[1])), req, env);
      }

      if (req.method === 'DELETE' && path.startsWith('/api/files/')) {
        const user = await auth(req, env);
        if (!user) return wrap(json({ error: 'Private session required' }, 401), req, env);
        return wrap(await removeFile(env, user, decodeURIComponent(path.slice('/api/files/'.length))), req, env);
      }
      if (req.method === 'GET' && path === '/api/workspace') {
        const user = await auth(req, env);
        if (!user) return wrap(json({ error: 'Private session required' }, 401), req, env);
        return wrap(await workspace(env, user), req, env);
      }
      if (req.method === 'POST' && path === '/api/organize') {
        const user = await auth(req, env);
        if (!user) return wrap(json({ error: 'Private session required' }, 401), req, env);
        return wrap(await organize(req, env, user), req, env);
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
        if (upload instanceof File && upload.size) {
          const response = await core.fetch(req, env);
          if (response.ok) {
            try {
              const data = await response.clone().json();
              if (data?.file?.id) await normalizeStoredFile(env, data.file.id);
            } catch {}
          }
          return wrap(response, req, env);
        }
      }
      return wrap(await core.fetch(req, env), req, env);
    } catch (e) {
      return wrap(json({ error: e?.message || 'Private Office error' }, e?.status || 500), req, env);
    }
  }
};
