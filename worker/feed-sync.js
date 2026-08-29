import app from './main.js';
import { ensure } from './db.js';

const ACK = /^Remembered\. I filed it as /i;
const MAINTENANCE = /organized Private Office:\s*\d+ moved/i;

function filingText(file) {
  const name = file?.name || file?.stored_name || file?.title || file?.original_name || 'Document';
  const category = file?.category || 'Other';
  const entity = file?.entity_name ? ` → ${file.entity_name}` : '';
  return `Remembered. I filed it as “${name}” under ${category}${entity}.`;
}

async function syncFeed(response, env) {
  if (!response.ok) return response;
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) return response;

  let data;
  try { data = await response.clone().json(); } catch { return response; }
  if (!Array.isArray(data?.messages)) return response;

  const original = data.messages;
  const updates = [];

  for (let i = 1; i < original.length; i++) {
    const current = original[i];
    const previous = original[i - 1];
    if (
      current?.role === 'assistant' &&
      ACK.test(String(current.text || '')) &&
      previous?.role === 'user' &&
      previous?.file
    ) {
      const next = filingText(previous.file);
      if (next !== current.text) {
        current.text = next;
        if (current.id) updates.push(env.DB.prepare('UPDATE messages SET text=? WHERE id=?').bind(next, current.id));
      }
    }
  }

  // Keep operational audit messages in D1, but do not clutter the personal-assistant conversation.
  data.messages = original.filter(m => !(m?.role === 'system' && MAINTENANCE.test(String(m.text || ''))));

  if (updates.length) {
    try { await env.DB.batch(updates); } catch (e) { console.log('feed acknowledgement sync failed', e?.message || e); }
  }

  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { status: response.status, headers });
}

export default {
  async fetch(req, env, ctx) {
    await ensure(env);
    const url = new URL(req.url);
    const response = await app.fetch(req, env, ctx);
    if (req.method === 'GET' && url.pathname === '/api/feed') return syncFeed(response, env);
    return response;
  }
};
