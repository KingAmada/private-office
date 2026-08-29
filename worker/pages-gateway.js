import app from './vault-gateway.js';
import { ensure, auth, role, session, hash, token, uid, now } from './db.js';

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8'}});
const origins=env=>String(env.APP_ORIGINS||'https://private-office.pages.dev,https://kingamada.github.io').split(',').map(x=>x.trim().replace(/\/$/,'')).filter(Boolean);
function cors(req,env){const origin=String(req.headers.get('Origin')||'').replace(/\/$/,'');const allowed=origins(env);return{'Access-Control-Allow-Origin':allowed.includes(origin)?origin:allowed[0]||'null','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Max-Age':'86400','Vary':'Origin'}}
function wrap(res,req,env){const h=new Headers(res.headers);for(const[k,v]of Object.entries(cors(req,env)))h.set(k,v);return new Response(res.body,{status:res.status,headers:h})}

async function health(env){
  const owner=await env.DB.prepare("SELECT id,name FROM people WHERE role='owner' AND active=1 LIMIT 1").first();
  return json({ok:true,service:'Private Office',storage:!!env.FILES,database:!!env.DB,owner_exists:!!owner});
}

async function ownerDeviceLink(req,env){
  const user=await auth(req,env);if(!user)return json({error:'Private session required'},401);role(user,['owner']);
  const id=uid(),raw=token(36),t=now(),expires=new Date(Date.now()+15*60*1000).toISOString();
  await env.DB.prepare('INSERT INTO invites(id,person_id,token_hash,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .bind(id,user.person_id,await hash(raw),user.person_id,t,expires).run();
  const appBase=String(env.APP_URL||'https://private-office.pages.dev/').replace(/\?.*$/,'');
  return json({ok:true,invite:{id,url:`${appBase}?invite=${encodeURIComponent(raw)}`,expires_at:expires,one_time:true}});
}

async function acceptOwnerInvite(req,env){
  let body={};try{body=await req.clone().json()}catch{}
  const h=await hash(body.token||'');
  const x=await env.DB.prepare(`SELECT i.id,i.person_id,i.expires_at,i.revoked_at,i.use_count,p.name,p.role,p.active
    FROM invites i JOIN people p ON p.id=i.person_id WHERE i.token_hash=? LIMIT 1`).bind(h).first();
  if(!x||x.role!=='owner')return null;
  if(x.revoked_at||!x.active||Number(x.use_count||0)>0||(x.expires_at&&Date.parse(x.expires_at)<=Date.now()))return json({error:'This Owner device link is invalid, expired or already used'},403);
  const sessionToken=await session(env,x.person_id,body.device_label||'Owner device');
  await env.DB.prepare('UPDATE invites SET use_count=use_count+1,revoked_at=? WHERE id=?').bind(now(),x.id).run();
  return json({session_token:sessionToken,person:{id:x.person_id,name:x.name,role:'owner'}});
}

export default{async fetch(req,env,ctx){
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors(req,env)});
  try{
    await ensure(env);const url=new URL(req.url),path=url.pathname;
    if(req.method==='GET'&&(path==='/'||path==='/api/health'))return wrap(await health(env),req,env);
    if(req.method==='POST'&&path==='/api/owner/device-link')return wrap(await ownerDeviceLink(req,env),req,env);
    if(req.method==='POST'&&path==='/api/invite/accept'){
      const own=await acceptOwnerInvite(req,env);if(own)return wrap(own,req,env);
    }
    return app.fetch(req,env,ctx);
  }catch(e){return wrap(json({error:e?.message||'Private Office migration error'},e?.status||500),req,env)}
}};
