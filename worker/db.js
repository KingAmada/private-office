export const SESSION_DAYS=90, INVITE_DAYS=30;
let ready=false;
const SCHEMA=`
CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,person_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_by TEXT,created_at TEXT NOT NULL,expires_at TEXT,revoked_at TEXT,use_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,person_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,device_label TEXT,created_at TEXT NOT NULL,last_seen TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT);
CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,r2_key TEXT NOT NULL UNIQUE,original_name TEXT NOT NULL,stored_name TEXT NOT NULL,mime TEXT,size INTEGER NOT NULL DEFAULT 0,sha256 TEXT NOT NULL,category TEXT,document_type TEXT,title TEXT,summary TEXT,search_text TEXT,entity_name TEXT,document_date TEXT,expiry_date TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,ai_used INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);
CREATE INDEX IF NOT EXISTS idx_files_created_by ON files(created_by);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,person_id TEXT,role TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',file_id TEXT,visible_to_person_id TEXT,created_at TEXT NOT NULL,reply_to TEXT);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_person ON messages(person_id);
CREATE TABLE IF NOT EXISTS multipart_uploads(id TEXT PRIMARY KEY,upload_id TEXT NOT NULL,r2_key TEXT NOT NULL,original_name TEXT NOT NULL,mime TEXT,size INTEGER NOT NULL DEFAULT 0,note TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'uploading');
CREATE INDEX IF NOT EXISTS idx_multipart_created_by ON multipart_uploads(created_by);
CREATE TABLE IF NOT EXISTS multipart_upload_meta(id TEXT PRIMARY KEY,data TEXT NOT NULL);
`;
export const now=()=>new Date().toISOString();
export const plusDays=d=>new Date(Date.now()+d*86400000).toISOString();
export const uid=()=>crypto.randomUUID();
export function token(n=32){const a=crypto.getRandomValues(new Uint8Array(n));let s='';for(const b of a)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'')}
export async function hash(v){const b=v instanceof ArrayBuffer?new Uint8Array(v):new TextEncoder().encode(String(v));const h=await crypto.subtle.digest('SHA-256',b);return[...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('')}
export async function ensure(env){if(ready)return;if(!env.DB||!env.FILES)throw new Error('D1/R2 bindings are missing');await env.DB.exec(SCHEMA);ready=true}
export async function thread(env){let r=await env.DB.prepare("SELECT id FROM threads WHERE title='Private Office' LIMIT 1").first();if(r?.id)return r.id;const id=uid(),t=now();await env.DB.prepare('INSERT INTO threads(id,title,created_at,updated_at) VALUES(?,?,?,?)').bind(id,'Private Office',t,t).run();return id}
export async function message(env,{personId=null,role='user',text='',fileId=null,visibleTo=null,replyTo=null}){const id=uid(),tid=await thread(env),t=now();await env.DB.prepare('INSERT INTO messages(id,thread_id,person_id,role,text,file_id,visible_to_person_id,created_at,reply_to) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,tid,personId,role,String(text||'').slice(0,30000),fileId,visibleTo,t,replyTo).run();await env.DB.prepare('UPDATE threads SET updated_at=? WHERE id=?').bind(t,tid).run();return{id,created_at:t}}
export async function session(env,personId,label=''){const raw=token(36),id=uid(),t=now();await env.DB.prepare('INSERT INTO sessions(id,person_id,token_hash,device_label,created_at,last_seen,expires_at) VALUES(?,?,?,?,?,?,?)').bind(id,personId,await hash(raw),String(label).slice(0,120),t,t,plusDays(SESSION_DAYS)).run();return raw}
export async function auth(req,env){const a=req.headers.get('Authorization')||'';if(!a.startsWith('Bearer '))return null;const r=await env.DB.prepare(`SELECT s.id session_id,s.person_id,s.expires_at,p.name,p.role,p.active FROM sessions s JOIN people p ON p.id=s.person_id WHERE s.token_hash=? AND s.revoked_at IS NULL LIMIT 1`).bind(await hash(a.slice(7))).first();if(!r||!r.active||Date.parse(r.expires_at)<=Date.now())return null;env.DB.prepare('UPDATE sessions SET last_seen=? WHERE id=?').bind(now(),r.session_id).run().catch(()=>{});return r}
export function role(user,allowed){if(!user||!allowed.includes(user.role)){const e=new Error('Not authorized');e.status=403;throw e}}
