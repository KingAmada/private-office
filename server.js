import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import Database from 'better-sqlite3';
import { google } from 'googleapis';
import OpenAI from 'openai';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT_NAME = process.env.PRIVATE_OFFICE_ROOT || 'Private Office';
const AUTO_CONF = Number(process.env.AUTO_ORGANIZE_CONFIDENCE || 0.82);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 30);
const MAX_SYNC = Number(process.env.MAX_SYNC_FILES_PER_RUN || 15);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

for (const key of ['SESSION_SECRET', 'APP_ENCRYPTION_KEY']) {
  if (!process.env[key]) console.warn(`[Private Office] Missing ${key}. Copy .env.example to .env before production use.`);
}

const dbPath = path.join(__dirname, 'data', 'private-office.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT,
  drive_url TEXT,
  drive_path TEXT,
  category TEXT,
  document_type TEXT,
  title TEXT,
  summary TEXT,
  search_text TEXT,
  linked_entity_type TEXT,
  linked_entity_name TEXT,
  document_date TEXT,
  expiry_date TEXT,
  sensitivity TEXT DEFAULT 'normal',
  confidence REAL DEFAULT 0,
  needs_review INTEGER DEFAULT 1,
  status TEXT DEFAULT 'indexed',
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id, drive_id)
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(owner_id, linked_entity_type, linked_entity_name);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  document_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunks_owner ON chunks(owner_id);
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id, type, normalized_name)
);
CREATE TABLE IF NOT EXISTS vault_meta (
  owner_id TEXT PRIMARY KEY,
  salt_b64 TEXT NOT NULL,
  verifier_b64 TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vault_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  label TEXT NOT NULL,
  username TEXT,
  url TEXT,
  ciphertext_b64 TEXT NOT NULL,
  iv_b64 TEXT NOT NULL,
  tag_b64 TEXT NOT NULL,
  notes_ciphertext_b64 TEXT,
  notes_iv_b64 TEXT,
  notes_tag_b64 TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vault_owner ON vault_items(owner_id);
`);

class SQLiteSessionStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires < Date.now()) {
        if (row) db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb = () => {}) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 864e5;
      db.prepare(`INSERT INTO sessions(sid,sess,expires) VALUES(?,?,?)
        ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires`).run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb = () => {}) {
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb(null); } catch (e) { cb(e); }
  }
  touch(sid, sess, cb = () => {}) { this.set(sid, sess, cb); }
}

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  name: 'privateoffice.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-change-me',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: new SQLiteSessionStore(),
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 864e5 }
}));

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false });
const aiLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 10 }
});

function appKey() {
  return crypto.createHash('sha256').update(process.env.APP_ENCRYPTION_KEY || 'dev-only-change-me').digest();
}
function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', appKey(), iv);
  const payload = Buffer.from(JSON.stringify(obj));
  const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}
function decryptJson(value) {
  const raw = Buffer.from(value, 'base64');
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', appKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'));
}

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_BASE_URL || `http://localhost:${PORT}`}/auth/google/callback`
  );
}
function requireAuth(req, res, next) {
  if (!req.session.user || !req.session.googleTokensEnc) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  next();
}
function driveFor(req) {
  const auth = oauthClient();
  auth.setCredentials(decryptJson(req.session.googleTokensEnc));
  auth.on('tokens', tokens => {
    try {
      const current = decryptJson(req.session.googleTokensEnc);
      req.session.googleTokensEnc = encryptJson({ ...current, ...tokens });
      req.session.save(() => {});
    } catch {}
  });
  return google.drive({ version: 'v3', auth });
}
function openaiClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}
function owner(req) { return req.session.user.sub; }
function safeSegment(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Unsorted';
}
function categoryFolder(category) {
  const map = {
    'Properties': 'Properties', 'Companies': 'Companies', 'Banking': 'Banking & Finance',
    'Personal': 'Personal', 'Legal': 'Legal & Agreements', 'Vehicles': 'Vehicles & Assets',
    'Insurance': 'Insurance', 'Investments': 'Investments', 'Taxes': 'Taxes', 'Other': 'Other'
  };
  return map[category] || 'Other';
}
async function ensureFolder(drive, name, parentId = 'root') {
  const qName = name.replace(/'/g, "\\'");
  const found = await drive.files.list({
    q: `'${parentId}' in parents and name='${qName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)', pageSize: 10
  });
  if (found.data.files?.[0]) return found.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id,name'
  });
  return created.data.id;
}
async function ensurePath(drive, segments) {
  let parent = 'root';
  for (const raw of segments) parent = await ensureFolder(drive, safeSegment(raw), parent);
  return parent;
}
async function moveFile(drive, fileId, newParentId) {
  const meta = await drive.files.get({ fileId, fields: 'parents' });
  const old = (meta.data.parents || []).join(',');
  await drive.files.update({ fileId, addParents: newParentId, removeParents: old || undefined, fields: 'id,parents' });
}
async function uploadBufferToDrive(drive, file, parentId) {
  const stream = new PassThrough();
  stream.end(file.buffer);
  const result = await drive.files.create({
    requestBody: { name: file.originalname, parents: [parentId] },
    media: { mimeType: file.mimetype || 'application/octet-stream', body: stream },
    fields: 'id,name,mimeType,webViewLink,createdTime,modifiedTime,parents,size'
  });
  return result.data;
}

const CLASSIFICATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    document_type: { type: 'string' },
    category: { type: 'string', enum: ['Properties','Companies','Banking','Personal','Legal','Vehicles','Insurance','Investments','Taxes','Other'] },
    title: { type: 'string' },
    summary: { type: 'string' },
    search_text: { type: 'string' },
    document_date: { type: ['string','null'] },
    expiry_date: { type: ['string','null'] },
    linked_entity_type: { type: ['string','null'], enum: ['property','company','person','banking','vehicle','investment','legal','insurance','tax','other',null] },
    linked_entity_name: { type: ['string','null'] },
    parties: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    sensitivity: { type: 'string', enum: ['normal','sensitive','vault_forbidden'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    needs_review: { type: 'boolean' }
  },
  required: ['document_type','category','title','summary','search_text','document_date','expiry_date','linked_entity_type','linked_entity_name','parties','tags','sensitivity','confidence','needs_review']
};

async function classifyBuffer(file) {
  const client = openaiClient();
  const tmpName = path.join(os.tmpdir(), `private-office-${crypto.randomUUID()}-${safeSegment(file.originalname)}`);
  fs.writeFileSync(tmpName, file.buffer);
  let aiFile;
  try {
    aiFile = await client.files.create({
      file: fs.createReadStream(tmpName),
      purpose: 'user_data',
      expires_after: { anchor: 'created_at', seconds: 3600 }
    });
    const response = await client.responses.create({
      model: OPENAI_MODEL,
      store: false,
      reasoning: { effort: 'low' },
      instructions: `You are Private Office's document intelligence engine. Read the supplied file carefully and classify it for a private personal records system.
Never output or copy OTPs, CVVs, card PINs, transaction PINs, passwords, recovery phrases, seed phrases, private keys, or authentication codes. If such material is present, set sensitivity to vault_forbidden, needs_review to true, and exclude those values from summary/search_text.
For ordinary sensitive records such as passports, bank statements, title documents and contracts, sensitivity may be sensitive but still classify them. Do not guess dates, ownership, parties or asset names that are not present. search_text should be a concise, high-recall searchable representation of the document, preserving useful names, places, document numbers and non-secret identifiers while excluding forbidden credentials.`,
      input: [{ role: 'user', content: [
        { type: 'input_text', text: `Filename: ${file.originalname}\nMIME type: ${file.mimetype || 'unknown'}\nReturn the structured classification.` },
        { type: 'input_file', file_id: aiFile.id }
      ]}],
      text: { format: { type: 'json_schema', name: 'private_office_document', strict: true, schema: CLASSIFICATION_SCHEMA }, verbosity: 'low' }
    });
    return JSON.parse(response.output_text);
  } finally {
    try { if (aiFile?.id) await client.files.delete(aiFile.id); } catch {}
    try { fs.unlinkSync(tmpName); } catch {}
  }
}

function splitText(text, size = 2800, overlap = 350) {
  const clean = String(text || '').replace(/\u0000/g, '').trim();
  if (!clean) return [];
  const chunks = [];
  for (let i = 0; i < clean.length; i += size - overlap) chunks.push(clean.slice(i, i + size));
  return chunks.slice(0, 18);
}
async function embedTexts(texts) {
  if (!texts.length) return [];
  const client = openaiClient();
  const r = await client.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  return r.data.map(x => x.embedding);
}
function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
async function indexDocument(ownerId, docId, classification) {
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(docId);
  if (classification.sensitivity === 'vault_forbidden') return;
  const base = [classification.title, classification.summary, classification.search_text,
    classification.linked_entity_name, ...(classification.parties || []), ...(classification.tags || [])].filter(Boolean).join('\n');
  const chunks = splitText(base);
  if (!chunks.length) return;
  const vectors = await embedTexts(chunks);
  const stmt = db.prepare('INSERT INTO chunks(owner_id,document_id,chunk_index,content,embedding_json) VALUES(?,?,?,?,?)');
  const tx = db.transaction(() => chunks.forEach((c, i) => stmt.run(ownerId, docId, i, c, JSON.stringify(vectors[i]))));
  tx();
}
function upsertEntity(ownerId, type, name) {
  if (!type || !name) return;
  const normalized = name.toLowerCase().replace(/\s+/g, ' ').trim();
  db.prepare(`INSERT INTO entities(owner_id,type,name,normalized_name) VALUES(?,?,?,?)
    ON CONFLICT(owner_id,type,normalized_name) DO UPDATE SET name=excluded.name`).run(ownerId, type, name, normalized);
}
function saveDocument(ownerId, driveMeta, drivePath, c) {
  const meta = JSON.stringify({ parties: c.parties || [], tags: c.tags || [] });
  db.prepare(`INSERT INTO documents(
    owner_id,drive_id,name,mime_type,drive_url,drive_path,category,document_type,title,summary,search_text,
    linked_entity_type,linked_entity_name,document_date,expiry_date,sensitivity,confidence,needs_review,status,metadata_json,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  ON CONFLICT(owner_id,drive_id) DO UPDATE SET
    name=excluded.name,mime_type=excluded.mime_type,drive_url=excluded.drive_url,drive_path=excluded.drive_path,
    category=excluded.category,document_type=excluded.document_type,title=excluded.title,summary=excluded.summary,
    search_text=excluded.search_text,linked_entity_type=excluded.linked_entity_type,linked_entity_name=excluded.linked_entity_name,
    document_date=excluded.document_date,expiry_date=excluded.expiry_date,sensitivity=excluded.sensitivity,
    confidence=excluded.confidence,needs_review=excluded.needs_review,status=excluded.status,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP`)
    .run(ownerId, driveMeta.id, driveMeta.name, driveMeta.mimeType || '', driveMeta.webViewLink || '', drivePath,
      c.category, c.document_type, c.title, c.summary, c.search_text, c.linked_entity_type, c.linked_entity_name,
      c.document_date, c.expiry_date, c.sensitivity, c.confidence, c.needs_review ? 1 : 0, 'indexed', meta);
  const row = db.prepare('SELECT id FROM documents WHERE owner_id=? AND drive_id=?').get(ownerId, driveMeta.id);
  upsertEntity(ownerId, c.linked_entity_type, c.linked_entity_name);
  return row.id;
}
async function organizeOne(req, file, existingDriveMeta = null) {
  const drive = driveFor(req);
  const rootId = await ensurePath(drive, [ROOT_NAME]);
  const inboxId = await ensureFolder(drive, 'Inbox', rootId);
  let driveMeta = existingDriveMeta;
  if (!driveMeta) driveMeta = await uploadBufferToDrive(drive, file, inboxId);

  let classification;
  try {
    classification = await classifyBuffer(file);
  } catch (err) {
    classification = {
      document_type: 'Unclassified document', category: 'Other', title: file.originalname,
      summary: 'AI classification failed. Review this document manually.', search_text: file.originalname,
      document_date: null, expiry_date: null, linked_entity_type: null, linked_entity_name: null,
      parties: [], tags: ['needs review'], sensitivity: 'normal', confidence: 0, needs_review: true
    };
  }

  let drivePath = existingDriveMeta ? 'Existing Google Drive · virtually organized' : `${ROOT_NAME} / Inbox`;
  const shouldMove = classification.sensitivity !== 'vault_forbidden' && !classification.needs_review && classification.confidence >= AUTO_CONF;
  if (existingDriveMeta) {
    // Existing Drive files are read/indexed but never physically moved by sync.
    // Their organization lives in Private Office's metadata layer.
  } else if (shouldMove) {
    const folderParts = [ROOT_NAME, categoryFolder(classification.category)];
    if (classification.linked_entity_name) folderParts.push(classification.linked_entity_name);
    const target = await ensurePath(drive, folderParts);
    await moveFile(drive, driveMeta.id, target);
    drivePath = folderParts.join(' / ');
  } else {
    const review = await ensureFolder(drive, 'Needs Review', rootId);
    await moveFile(drive, driveMeta.id, review);
    drivePath = `${ROOT_NAME} / Needs Review`;
  }

  const refreshed = await drive.files.get({ fileId: driveMeta.id, fields: 'id,name,mimeType,webViewLink,parents,size,modifiedTime' });
  driveMeta = refreshed.data;
  const docId = saveDocument(owner(req), driveMeta, drivePath, classification);
  try { await indexDocument(owner(req), docId, classification); } catch (e) { console.warn('Indexing failed:', e.message); }
  return { id: docId, driveId: driveMeta.id, name: driveMeta.name, driveUrl: driveMeta.webViewLink, drivePath, ...classification };
}

async function downloadDriveFile(drive, meta) {
  const mime = meta.mimeType || '';
  if (mime.startsWith('application/vnd.google-apps.')) {
    if (mime === 'application/vnd.google-apps.folder') return null;
    const exportable = [
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
      'application/vnd.google-apps.drawing'
    ];
    if (!exportable.includes(mime)) return null;
    const r = await drive.files.export({ fileId: meta.id, mimeType: 'application/pdf' }, { responseType: 'arraybuffer' });
    return { buffer: Buffer.from(r.data), originalname: `${meta.name}.pdf`, mimetype: 'application/pdf' };
  }
  if (Number(meta.size || 0) > MAX_UPLOAD_MB * 1024 * 1024) return null;
  const r = await drive.files.get({ fileId: meta.id, alt: 'media' }, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(r.data), originalname: meta.name, mimetype: meta.mimeType || 'application/octet-stream' };
}

async function semanticSearch(ownerId, query, limit = 8) {
  const [qVec] = await embedTexts([query]);
  const rows = db.prepare(`SELECT c.document_id,c.content,c.embedding_json,d.title,d.name,d.summary,d.drive_url,d.drive_path,d.category,d.linked_entity_name,d.document_type
    FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.owner_id=? LIMIT 6000`).all(ownerId);
  const scored = rows.map(r => ({ ...r, score: cosine(qVec, JSON.parse(r.embedding_json)) })).sort((a,b) => b.score - a.score);
  const seen = new Set(), out = [];
  for (const r of scored) {
    if (seen.has(r.document_id)) continue;
    seen.add(r.document_id); out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// --- Auth ---
app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.status(500).send('Google OAuth is not configured. Add credentials to .env.');
  const client = oauthClient();
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  const driveScopes = String(process.env.GOOGLE_DRIVE_SCOPES || 'https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/drive.file')
    .split(',').map(s => s.trim()).filter(Boolean);
  const scope = ['openid', 'email', 'profile', ...driveScopes];
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', include_granted_scopes: true, scope, state });
  res.redirect(url);
});
app.get('/auth/google/callback', async (req, res) => {
  try {
    if (!req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send('OAuth state mismatch.');
    const client = oauthClient();
    const { tokens } = await client.getToken(String(req.query.code || ''));
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: profile } = await oauth2.userinfo.get();
    req.session.user = { sub: profile.id, email: profile.email, name: profile.name, picture: profile.picture };
    req.session.googleTokensEnc = encryptJson(tokens);
    delete req.session.oauthState;
    req.session.save(() => res.redirect('/'));
  } catch (e) {
    console.error('OAuth callback:', e);
    res.status(500).send('Google sign-in failed. Check your OAuth redirect URI and credentials.');
  }
});
app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// --- Status/dashboard ---
app.get('/api/status', (req, res) => {
  res.json({
    authenticated: Boolean(req.session.user && req.session.googleTokensEnc),
    user: req.session.user || null,
    configured: {
      google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      openai: Boolean(process.env.OPENAI_API_KEY)
    },
    model: OPENAI_MODEL,
    root: ROOT_NAME
  });
});
app.get('/api/dashboard', requireAuth, (req, res) => {
  const oid = owner(req);
  const total = db.prepare('SELECT COUNT(*) n FROM documents WHERE owner_id=?').get(oid).n;
  const review = db.prepare('SELECT COUNT(*) n FROM documents WHERE owner_id=? AND needs_review=1').get(oid).n;
  const entities = db.prepare('SELECT type,COUNT(*) n FROM entities WHERE owner_id=? GROUP BY type').all(oid);
  const recent = db.prepare(`SELECT id,title,name,category,document_type,drive_url,drive_path,linked_entity_name,needs_review,updated_at FROM documents WHERE owner_id=? ORDER BY updated_at DESC LIMIT 8`).all(oid);
  const cats = db.prepare('SELECT category,COUNT(*) n FROM documents WHERE owner_id=? GROUP BY category ORDER BY n DESC').all(oid);
  res.json({ total, review, entities, recent, categories: cats });
});

// --- Upload / Drive ---
app.post('/api/upload', requireAuth, aiLimiter, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
    const results = [];
    for (const file of req.files) results.push(await organizeOne(req, file));
    res.json({ ok: true, results });
  } catch (e) {
    console.error('/api/upload', e);
    res.status(500).json({ error: 'Upload or classification failed', detail: process.env.NODE_ENV === 'development' ? e.message : undefined });
  }
});
app.post('/api/drive/sync', requireAuth, aiLimiter, async (req, res) => {
  try {
    const drive = driveFor(req);
    const pageSize = Math.max(1, Math.min(Number(req.body?.limit || MAX_SYNC), MAX_SYNC));
    const list = await drive.files.list({
      q: "trashed=false and mimeType!='application/vnd.google-apps.folder'",
      pageSize: Math.min(100, pageSize * 5),
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,mimeType,webViewLink,size,modifiedTime,parents)'
    });
    const indexed = new Set(db.prepare('SELECT drive_id FROM documents WHERE owner_id=?').all(owner(req)).map(x => x.drive_id));
    const candidates = (list.data.files || []).filter(f => !indexed.has(f.id)).slice(0, pageSize);
    const results = [], skipped = [];
    for (const meta of candidates) {
      try {
        const file = await downloadDriveFile(drive, meta);
        if (!file) { skipped.push({ id: meta.id, name: meta.name, reason: 'unsupported-or-too-large' }); continue; }
        results.push(await organizeOne(req, file, meta));
      } catch (e) {
        skipped.push({ id: meta.id, name: meta.name, reason: e.message });
      }
    }
    res.json({ ok: true, indexed: results.length, results, skipped, remainingHint: (list.data.files || []).length > candidates.length });
  } catch (e) {
    console.error('/api/drive/sync', e);
    res.status(500).json({ error: 'Drive sync failed', detail: process.env.NODE_ENV === 'development' ? e.message : undefined });
  }
});
app.get('/api/documents', requireAuth, (req, res) => {
  const oid = owner(req);
  const q = String(req.query.q || '').trim();
  const category = String(req.query.category || '').trim();
  const review = req.query.review === '1';
  const params = [oid]; let where = 'owner_id=?';
  if (q) { where += ' AND (title LIKE ? OR name LIKE ? OR summary LIKE ? OR linked_entity_name LIKE ?)'; const like = `%${q}%`; params.push(like,like,like,like); }
  if (category) { where += ' AND category=?'; params.push(category); }
  if (review) where += ' AND needs_review=1';
  const rows = db.prepare(`SELECT id,title,name,category,document_type,summary,linked_entity_type,linked_entity_name,document_date,expiry_date,sensitivity,confidence,needs_review,drive_url,drive_path,updated_at FROM documents WHERE ${where} ORDER BY updated_at DESC LIMIT 100`).all(...params);
  res.json({ results: rows });
});

// --- Chat ---
app.post('/api/chat', requireAuth, aiLimiter, async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message required' });
    if (/\b(otp|cvv|card\s*pin|transaction\s*pin|seed\s*phrase|recovery\s*phrase|private\s*key)\b/i.test(message)) {
      return res.json({ answer: 'That type of credential is intentionally excluded from AI search. Private Office will not reveal OTPs, CVVs, PINs, seed phrases or private keys through chat.', sources: [], vaultRequired: true });
    }
    const hits = await semanticSearch(owner(req), message, 7);
    const context = hits.map((h, i) => `[Record ${i+1}]\nTitle: ${h.title || h.name}\nType: ${h.document_type}\nCategory: ${h.category}\nLinked record: ${h.linked_entity_name || 'none'}\nDrive path: ${h.drive_path || ''}\nSummary/search context: ${h.content}`).join('\n\n');
    const client = openaiClient();
    const response = await client.responses.create({
      model: OPENAI_MODEL,
      store: false,
      reasoning: { effort: 'low' },
      instructions: `You are Private Office, a calm, precise private chief-of-staff assistant. Answer only from the supplied private index context. If the context is insufficient, say you could not find enough evidence and suggest what to upload or index. Never fabricate ownership, dates, balances, legal status, locations or credentials. Never reveal or infer OTPs, CVVs, PINs, passwords, seed phrases, recovery phrases or private keys. Keep answers concise and useful. When useful, refer to records by their exact title.`,
      input: `User request:\n${message}\n\nPrivate index context:\n${context || '(No matching indexed records.)'}`,
      text: { verbosity: 'low' }
    });
    res.json({
      answer: response.output_text,
      sources: hits.slice(0, 5).map(h => ({ id: h.document_id, title: h.title || h.name, summary: h.summary, category: h.category, entity: h.linked_entity_name, driveUrl: h.drive_url, drivePath: h.drive_path, score: Number(h.score.toFixed(3)) }))
    });
  } catch (e) {
    console.error('/api/chat', e);
    res.status(500).json({ error: 'Assistant request failed', detail: process.env.NODE_ENV === 'development' ? e.message : undefined });
  }
});

// --- Vault: passwords only, not card PIN/CVV/OTP/seed phrases ---
function deriveVaultKey(password, salt) { return crypto.scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1 }); }
function verifierFor(key) { return crypto.createHmac('sha256', key).update('private-office-vault-verifier-v1').digest(); }
function verifyVaultPassword(ownerId, password) {
  const row = db.prepare('SELECT salt_b64,verifier_b64 FROM vault_meta WHERE owner_id=?').get(ownerId);
  if (!row) return { ok: false, reason: 'not_setup' };
  const salt = Buffer.from(row.salt_b64, 'base64');
  const key = deriveVaultKey(password, salt);
  const expected = Buffer.from(row.verifier_b64, 'base64');
  const actual = verifierFor(key);
  return { ok: expected.length === actual.length && crypto.timingSafeEqual(expected, actual), key };
}
function encryptSecret(text, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return { ciphertext_b64: ct.toString('base64'), iv_b64: iv.toString('base64'), tag_b64: cipher.getAuthTag().toString('base64') };
}
function decryptSecret(row, prefix, key) {
  const ct = Buffer.from(row[`${prefix}ciphertext_b64`], 'base64');
  const iv = Buffer.from(row[`${prefix}iv_b64`], 'base64');
  const tag = Buffer.from(row[`${prefix}tag_b64`], 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
app.get('/api/vault/status', requireAuth, (req, res) => {
  const setup = Boolean(db.prepare('SELECT 1 FROM vault_meta WHERE owner_id=?').get(owner(req)));
  const count = setup ? db.prepare('SELECT COUNT(*) n FROM vault_items WHERE owner_id=?').get(owner(req)).n : 0;
  res.json({ setup, count });
});
app.post('/api/vault/setup', requireAuth, (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 12) return res.status(400).json({ error: 'Use a vault password of at least 12 characters.' });
  if (db.prepare('SELECT 1 FROM vault_meta WHERE owner_id=?').get(owner(req))) return res.status(409).json({ error: 'Vault is already configured.' });
  const salt = crypto.randomBytes(16), key = deriveVaultKey(password, salt), verifier = verifierFor(key);
  db.prepare('INSERT INTO vault_meta(owner_id,salt_b64,verifier_b64) VALUES(?,?,?)').run(owner(req), salt.toString('base64'), verifier.toString('base64'));
  res.json({ ok: true });
});
app.get('/api/vault/items', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id,label,username,url,created_at,updated_at FROM vault_items WHERE owner_id=? ORDER BY label').all(owner(req));
  res.json({ results: rows });
});
app.post('/api/vault/items', requireAuth, (req, res) => {
  const { label, username='', url='', password='', notes='', vaultPassword='' } = req.body || {};
  if (!label || !password || !vaultPassword) return res.status(400).json({ error: 'Label, password and vault password are required.' });
  if (/\b(otp|cvv|pin|seed phrase|recovery phrase|private key)\b/i.test(String(label))) return res.status(400).json({ error: 'Private Office intentionally refuses to store PINs, CVVs, OTPs, seed phrases, recovery phrases or private keys.' });
  const v = verifyVaultPassword(owner(req), String(vaultPassword));
  if (!v.ok) return res.status(403).json({ error: 'Incorrect vault password.' });
  const sec = encryptSecret(password, v.key), note = notes ? encryptSecret(notes, v.key) : null;
  const r = db.prepare(`INSERT INTO vault_items(owner_id,label,username,url,ciphertext_b64,iv_b64,tag_b64,notes_ciphertext_b64,notes_iv_b64,notes_tag_b64)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(owner(req), String(label), String(username), String(url), sec.ciphertext_b64, sec.iv_b64, sec.tag_b64,
      note?.ciphertext_b64 || null, note?.iv_b64 || null, note?.tag_b64 || null);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.post('/api/vault/reveal', requireAuth, rateLimit({ windowMs: 60_000, limit: 12 }), (req, res) => {
  const id = Number(req.body?.id), vaultPassword = String(req.body?.vaultPassword || '');
  const v = verifyVaultPassword(owner(req), vaultPassword);
  if (!v.ok) return res.status(403).json({ error: 'Incorrect vault password.' });
  const row = db.prepare('SELECT * FROM vault_items WHERE id=? AND owner_id=?').get(id, owner(req));
  if (!row) return res.status(404).json({ error: 'Credential not found.' });
  const password = decryptSecret(row, '', v.key);
  let notes = '';
  if (row.notes_ciphertext_b64) {
    notes = decryptSecret({ ciphertext_b64: row.notes_ciphertext_b64, iv_b64: row.notes_iv_b64, tag_b64: row.notes_tag_b64 }, '', v.key);
  }
  res.set('Cache-Control', 'no-store');
  res.json({ id: row.id, label: row.label, username: row.username, url: row.url, password, notes });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use((req, res, next) => {
  if (req.method === 'GET') return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  next();
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error' });
});

app.listen(PORT, () => console.log(`Private Office running on http://localhost:${PORT}`));
