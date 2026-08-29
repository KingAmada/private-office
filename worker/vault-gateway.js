import app from './feed-sync.js';
import { ensure, auth } from './db.js';
import { handleVaultChat, listVault, revealVault, deleteVault, migrateLegacyVault } from './vault.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const origins = env => String(env.APP_ORIGINS || 'https://kingamada.github.io').split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean);
function cors(req, env) {
  const origin = String(req.headers.get('Origin') || '').replace(/\/$/, '');
  const allowed = origins(env);
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || 'null',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function wrap(res, req, env) {
  const h = new Headers(res.headers);
  for (const [k,v] of Object.entries(cors(req, env))) h.set(k,v);
  return new Response(res.body,{status:res.status,headers:h});
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null,{status:204,headers:cors(req,env)});
    try {
      await ensure(env);
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === 'POST' && path === '/api/message') {
        const clone = req.clone();
        let fd;
        try { fd = await clone.formData(); } catch { fd = null; }
        const upload = fd?.get('file');
        const text = String(fd?.get('text') || '').trim();
        if (!(upload instanceof File && upload.size) && /\bpassword\b/i.test(text)) {
          const user = await auth(req, env);
          if (!user) return wrap(json({error:'Private session required'},401),req,env);
          const response = await handleVaultChat(env,user,text);
          if (response) return wrap(response,req,env);
        }
      }

      if (req.method === 'GET' && path === '/api/feed') {
        const user = await auth(req, env);
        if (user?.role === 'owner') {
          try { await migrateLegacyVault(env,user); } catch (e) { console.log('legacy vault migration failed',e?.message||e); }
        }
        return app.fetch(req,env,ctx);
      }

      if (path === '/api/vault') {
        const user = await auth(req,env);
        if (!user) return wrap(json({error:'Private session required'},401),req,env);
        if (req.method === 'GET') return wrap(await listVault(env,user),req,env);
      }

      const reveal = path.match(/^\/api\/vault\/([^/]+)\/reveal$/);
      if (req.method === 'POST' && reveal) {
        const user = await auth(req,env);
        if (!user) return wrap(json({error:'Private session required'},401),req,env);
        return wrap(await revealVault(env,user,decodeURIComponent(reveal[1])),req,env);
      }

      const item = path.match(/^\/api\/vault\/([^/]+)$/);
      if (req.method === 'DELETE' && item) {
        const user = await auth(req,env);
        if (!user) return wrap(json({error:'Private session required'},401),req,env);
        return wrap(await deleteVault(env,user,decodeURIComponent(item[1])),req,env);
      }

      return app.fetch(req,env,ctx);
    } catch (e) {
      return wrap(json({error:e?.message||'Private Vault error'},e?.status||500),req,env);
    }
  }
};
