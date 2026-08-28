(() => {
'use strict';

const C = window.PRIVATE_OFFICE_CONFIG || {};
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const ROOT = C.ROOT_FOLDER || 'Private Office';
const ORGANIZER_VERSION = 5;
const MAX_AI_PER_RUN = 8;
const MAX_FILES_PER_RUN = 100;
const AI_MAX = (Number(C.MAX_AI_FILE_MB) || 8) * 1024 * 1024;

const CATEGORY_FOLDER = {
  Properties: 'Properties',
  Companies: 'Companies',
  Banking: 'Banking & Finance',
  Personal: 'Personal',
  Legal: 'Legal & Agreements',
  Vehicles: 'Vehicles & Assets',
  Insurance: 'Insurance',
  Investments: 'Investments',
  Taxes: 'Taxes',
  Other: 'Other'
};

const S = {
  running: false,
  accessToken: null,
  tokenClient: null,
  tokenWaiter: null,
  uploadWasOpen: false
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const safe = s => String(s || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
const qName = s => String(s || '').replace(/'/g, "\\'");
const extOf = name => { const m = String(name || '').match(/(\.[A-Za-z0-9]{1,8})$/); return m ? m[1].toLowerCase() : ''; };
const baseOf = name => extOf(name) ? String(name).slice(0, -extOf(name).length) : String(name || 'Document');
const cleanBase = name => safe(baseOf(name).replace(/[_]+/g, ' ').replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' '));
const titleCase = s => String(s || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

function toast(message) {
  const t = document.querySelector('#toast');
  if (!t) return;
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 4200);
}

function status(message) {
  const el = document.querySelector('#syncState');
  if (el) el.textContent = message;
}

function setOrganizeLabels() {
  document.querySelectorAll('[data-action="sync"]').forEach(b => {
    b.textContent = 'Organize Drive';
    b.title = 'Classify, rename and file Private Office documents';
  });
}

function cachedToken() {
  const cached = window.PrivateOfficeSession?.getDriveToken?.();
  return cached?.access_token || null;
}

function initTokenClient() {
  if (S.tokenClient || !window.google?.accounts?.oauth2) return;
  S.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: C.GOOGLE_CLIENT_ID,
    scope: 'openid email profile https://www.googleapis.com/auth/drive',
    callback: r => {
      const waiter = S.tokenWaiter;
      S.tokenWaiter = null;
      if (r?.error) {
        waiter?.reject(new Error(r.error_description || r.error));
        return;
      }
      if (r?.access_token) S.accessToken = r.access_token;
      waiter?.resolve(r?.access_token);
    }
  });
}

async function getToken(interactive = true) {
  if (S.accessToken) return S.accessToken;
  const saved = cachedToken();
  if (saved) {
    S.accessToken = saved;
    return saved;
  }

  if (!interactive) throw new Error('Drive session needs reconnecting');

  for (let i = 0; i < 50 && !window.google?.accounts?.oauth2; i++) await sleep(100);
  initTokenClient();
  if (!S.tokenClient) throw new Error('Google Drive authorization is not ready');

  return new Promise((resolve, reject) => {
    S.tokenWaiter = { resolve, reject };
    // Empty prompt means Google only asks for consent when it is actually needed.
    S.tokenClient.requestAccessToken({ prompt: '' });
  });
}

async function driveFetch(url, opts = {}, retry = true, interactive = true) {
  await getToken(interactive);
  const headers = { ...(opts.headers || {}), Authorization: `Bearer ${S.accessToken}` };
  const r = await fetch(url, { ...opts, headers });

  if (r.status === 401 && retry) {
    S.accessToken = null;
    sessionStorage.removeItem('po_drive_token_v2');
    await getToken(interactive);
    return driveFetch(url, opts, false, interactive);
  }

  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json())?.error?.message || ''; } catch {}
    throw new Error(detail || `Google Drive request failed (${r.status})`);
  }
  return r;
}

async function driveJson(url, opts = {}, interactive = true) {
  return (await driveFetch(url, opts, true, interactive)).json();
}

async function listAll(q, fields, interactive = true, cap = 5000) {
  const out = [];
  let pageToken = '';
  do {
    const u = `${DRIVE}/files?q=${encodeURIComponent(q)}&spaces=drive&pageSize=1000&fields=${encodeURIComponent(`nextPageToken,files(${fields})`)}` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const d = await driveJson(u, {}, interactive);
    out.push(...(d.files || []));
    pageToken = d.nextPageToken || '';
  } while (pageToken && out.length < cap);
  return out;
}

async function findFolder(name, parent = 'root', interactive = true) {
  const q = `'${parent}' in parents and name='${qName(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const d = await driveJson(`${DRIVE}/files?q=${encodeURIComponent(q)}&spaces=drive&pageSize=10&fields=files(id,name,parents)`, {}, interactive);
  return d.files?.[0] || null;
}

async function ensureFolder(name, parent = 'root', interactive = true) {
  const found = await findFolder(name, parent, interactive);
  if (found) return found.id;
  const d = await driveJson(`${DRIVE}/files?fields=id,name,parents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] })
  }, interactive);
  return d.id;
}

async function readJsonFile(id, interactive = true) {
  const r = await driveFetch(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media`, {}, true, interactive);
  return JSON.parse(await r.text());
}

async function writeJsonFile(id, obj, interactive = true) {
  await driveFetch(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj, null, 2)
  }, true, interactive);
}

async function workspace(interactive = true) {
  const rootId = await ensureFolder(ROOT, 'root', interactive);
  const systemId = await ensureFolder('.system', rootId, interactive);
  const q = `'${systemId}' in parents and name='private-office-index.json' and trashed=false`;
  const found = await driveJson(`${DRIVE}/files?q=${encodeURIComponent(q)}&spaces=drive&pageSize=10&fields=files(id,name)`, {}, interactive);
  let indexFileId = found.files?.[0]?.id;

  if (!indexFileId) {
    const meta = await driveJson(`${DRIVE}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'private-office-index.json', mimeType: 'application/json', parents: [systemId] })
    }, interactive);
    indexFileId = meta.id;
    await writeJsonFile(indexFileId, { version: 2, updatedAt: null, documents: [] }, interactive);
  }

  let index;
  try { index = await readJsonFile(indexFileId, interactive); }
  catch { index = { version: 2, updatedAt: null, documents: [] }; }
  if (!Array.isArray(index.documents)) index.documents = [];
  return { rootId, systemId, indexFileId, index };
}

function normalizedFilename(existing, desired) {
  const ext = extOf(existing);
  let base = safe(baseOf(desired || existing));
  base = base.replace(/^[-_. ]+|[-_. ]+$/g, '').slice(0, 110) || cleanBase(existing) || 'Document';
  return `${base}${ext}`;
}

function niceNameFromRecord(rec, meta) {
  const pieces = [];
  if (rec?.entityName) pieces.push(rec.entityName);
  if (rec?.documentType && !/^(document|other)$/i.test(rec.documentType)) pieces.push(rec.documentType);
  if (rec?.documentDate) pieces.push(rec.documentDate);
  if (!pieces.length && rec?.title && rec.title !== meta.name) pieces.push(rec.title);
  if (!pieces.length) return titleCase(cleanBase(meta.name));
  return pieces.map(safe).filter(Boolean).join(' - ');
}

function ruleClassification(meta, path = '') {
  const n = `${meta.name || ''} ${path || ''}`.toLowerCase().replace(/[_-]+/g, ' ');
  const clean = cleanBase(meta.name);
  const make = (category, type, entityType = null) => ({
    document_type: type,
    category,
    title: clean || type,
    summary: `${type} identified from its filename and Drive context.`,
    search_text: `${clean} ${path}`.trim().slice(0, 260),
    document_date: null,
    expiry_date: null,
    linked_entity_type: entityType,
    linked_entity_name: null,
    parties: [],
    tags: [type.toLowerCase()],
    sensitivity: 'normal',
    confidence: 0.98,
    needs_review: false,
    suggested_filename: titleCase(clean || type),
    ai_used: false,
    classification_source: 'rules'
  });

  if (/\b(account|bank)\s+statement\b|statement\s*\d{2,}/.test(n)) return make('Banking', 'Account Statement', 'banking');
  if (/\b(certificate of occupancy|c\s*of\s*o|right of occupancy|deed of assignment|deed of conveyance|survey plan|land title|allocation letter|plot allocation)\b/.test(n)) return make('Properties', 'Property Title Document', 'property');
  if (/\b(cac|certificate of incorporation|incorporation|memorandum and articles|memart|company registration|rc\s*\d+)\b/.test(n)) return make('Companies', 'Company Registration Document', 'company');
  if (/\b(passport|national id|national identification|\bnin\b|birth certificate|drivers? licence|drivers? license)\b/.test(n)) return make('Personal', 'Identity Document', 'person');
  if (/\b(invoice|payment receipt|bank receipt|transfer receipt|remittance)\b/.test(n)) return make('Banking', /invoice/.test(n) ? 'Invoice' : 'Payment Receipt', 'banking');
  if (/\b(quotation|quotations|price quote|purchase order|proposal)\b/.test(n)) return make('Companies', /proposal/.test(n) ? 'Business Proposal' : 'Quotation', 'company');
  if (/\b(vehicle registration|roadworthiness|vehicle licence|vehicle license|car registration)\b/.test(n)) return make('Vehicles', 'Vehicle Document', 'vehicle');
  if (/\b(insurance policy|insurance certificate|insurance renewal)\b/.test(n)) return make('Insurance', 'Insurance Document', 'insurance');
  if (/\b(share certificate|investment statement|portfolio statement|dividend|stock statement)\b/.test(n)) return make('Investments', 'Investment Document', 'investment');
  if (/\b(tax clearance|tax return|\bfirs\b|\bvat\b|tax assessment)\b/.test(n)) return make('Taxes', 'Tax Document', 'tax');
  if (/\b(nda|non disclosure|contract|legal agreement|tenancy agreement|lease agreement|affidavit|court order)\b/.test(n)) return make('Legal', 'Legal Agreement', 'legal');
  return null;
}

function reusableRecord(rec) {
  if (!rec) return false;
  const placeholder = /uploaded but ai classification needs review|not yet been fully classified/i.test(String(rec.summary || ''));
  return !placeholder && Number(rec.confidence || 0) >= 0.86 && rec.category && rec.category !== 'Other' && rec.documentType;
}

function classificationFromRecord(rec, meta) {
  return {
    document_type: rec.documentType || 'Document',
    category: rec.category || 'Other',
    title: rec.title || cleanBase(meta.name),
    summary: rec.summary || '',
    search_text: rec.searchText || '',
    document_date: rec.documentDate || null,
    expiry_date: rec.expiryDate || null,
    linked_entity_type: rec.entityType || null,
    linked_entity_name: rec.entityName || null,
    parties: rec.parties || [],
    tags: rec.tags || [],
    sensitivity: rec.sensitivity || 'normal',
    confidence: Number(rec.confidence || 0.9),
    needs_review: Boolean(rec.needsReview),
    suggested_filename: niceNameFromRecord(rec, meta),
    ai_used: Boolean(rec.aiUsed),
    classification_source: 'reused'
  };
}

async function getContent(meta, interactive = true) {
  let url;
  let type = meta.mimeType || 'application/octet-stream';
  let name = meta.name;

  if (type === 'application/vnd.google-apps.document') {
    url = `${DRIVE}/files/${meta.id}/export?mimeType=${encodeURIComponent('text/plain')}`;
    type = 'text/plain'; name += '.txt';
  } else if (type === 'application/vnd.google-apps.spreadsheet') {
    url = `${DRIVE}/files/${meta.id}/export?mimeType=${encodeURIComponent('text/csv')}`;
    type = 'text/csv'; name += '.csv';
  } else if (type === 'application/vnd.google-apps.presentation') {
    url = `${DRIVE}/files/${meta.id}/export?mimeType=${encodeURIComponent('application/pdf')}`;
    type = 'application/pdf'; name += '.pdf';
  } else if (type.startsWith('application/vnd.google-apps.')) {
    throw new Error('Unsupported Google native file type');
  } else {
    url = `${DRIVE}/files/${meta.id}?alt=media`;
  }

  const r = await driveFetch(url, {}, true, interactive);
  const blob = await r.blob();
  if (blob.size > AI_MAX) throw new Error('File is above the AI scan limit');
  return { blob, name, type };
}

function toBase64(blob, name, type) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = reject;
    fr.readAsDataURL(new File([blob], name, { type }));
  });
}

async function aiClassify(meta, path, interactive = true) {
  const idToken = sessionStorage.getItem('po_id_token');
  if (!idToken) throw new Error('Google identity session missing');
  const f = await getContent(meta, interactive);
  const base64 = await toBase64(f.blob, f.name, f.type);
  const r = await fetch(C.AI_GATEWAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({
      action: 'classify',
      name: f.name,
      mime: f.type,
      base64,
      current_path: path,
      organizer: true
    })
  });
  let d = {};
  try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(d.error || `AI classification failed (${r.status})`);
  return { classification: d.classification, usage: d.usage || null };
}

async function folderMap(interactive = true) {
  const folders = await listAll("trashed=false and mimeType='application/vnd.google-apps.folder'", 'id,name,parents', interactive);
  return new Map(folders.map(f => [f.id, f]));
}

function pathFor(meta, folders) {
  const names = [];
  let id = meta.parents?.[0];
  const seen = new Set();
  while (id && folders.has(id) && !seen.has(id) && names.length < 10) {
    seen.add(id);
    const f = folders.get(id);
    names.unshift(f.name);
    id = f.parents?.[0];
  }
  return names.join(' / ');
}

function isBelow(meta, ancestorId, folders) {
  let id = meta.parents?.[0];
  const seen = new Set();
  while (id && !seen.has(id)) {
    if (id === ancestorId) return true;
    seen.add(id);
    id = folders.get(id)?.parents?.[0];
  }
  return false;
}

async function destination(ws, c, interactive = true) {
  if (c.sensitivity === 'vault_forbidden' || c.needs_review || Number(c.confidence || 0) < 0.82) {
    return { id: await ensureFolder('Needs Review', ws.rootId, interactive), path: `${ROOT} / Needs Review` };
  }

  const categoryName = CATEGORY_FOLDER[c.category] || 'Other';
  const categoryId = await ensureFolder(categoryName, ws.rootId, interactive);
  if (c.linked_entity_name) {
    const entity = safe(c.linked_entity_name);
    if (entity) {
      const entityId = await ensureFolder(entity, categoryId, interactive);
      return { id: entityId, path: `${ROOT} / ${categoryName} / ${entity}` };
    }
  }
  return { id: categoryId, path: `${ROOT} / ${categoryName}` };
}

async function mutateFile(meta, c, dest, interactive = true) {
  const desired = c.sensitivity === 'vault_forbidden'
    ? meta.name
    : normalizedFilename(meta.name, c.suggested_filename || c.title || meta.name);

  const parents = meta.parents || [];
  const moved = !parents.includes(dest.id);
  const renamed = desired !== meta.name;

  if (!moved && !renamed) {
    return { meta: { ...meta }, moved: false, renamed: false, oldName: meta.name, newName: meta.name };
  }

  let url = `${DRIVE}/files/${encodeURIComponent(meta.id)}?fields=id,name,mimeType,webViewLink,modifiedTime,size,parents`;
  if (moved) {
    url += `&addParents=${encodeURIComponent(dest.id)}`;
    if (parents.length) url += `&removeParents=${encodeURIComponent(parents.join(','))}`;
  }

  const changed = await driveJson(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(renamed ? { name: desired } : {})
  }, interactive);

  return {
    meta: changed,
    moved,
    renamed,
    oldName: meta.name,
    newName: changed.name || desired
  };
}

function upsert(index, old, before, after, c, destPath, source) {
  const now = new Date().toISOString();
  const rec = old || { id: crypto.randomUUID(), indexedAt: now };
  const originalName = rec.originalName || before.name;
  Object.assign(rec, {
    driveId: after.id,
    name: after.name,
    originalName,
    title: c.title || cleanBase(after.name),
    documentType: c.document_type || 'Document',
    category: c.category || 'Other',
    summary: c.summary || '',
    searchText: c.search_text || '',
    documentDate: c.document_date || null,
    expiryDate: c.expiry_date || null,
    entityType: c.linked_entity_type || null,
    entityName: c.linked_entity_name || null,
    tags: c.tags || [],
    parties: c.parties || [],
    sensitivity: c.sensitivity || 'normal',
    confidence: Number(c.confidence || 0),
    needsReview: Boolean(c.needs_review || Number(c.confidence || 0) < 0.82),
    driveUrl: after.webViewLink || `https://drive.google.com/open?id=${after.id}`,
    drivePath: destPath,
    existingDrive: true,
    modifiedTime: after.modifiedTime || before.modifiedTime || null,
    lastProcessedModifiedTime: after.modifiedTime || before.modifiedTime || null,
    organizerVersion: ORGANIZER_VERSION,
    classificationSource: source,
    aiUsed: Boolean(c.ai_used || source === 'ai'),
    organizedName: after.name,
    organizedPath: destPath,
    lastOrganizedAt: now
  });
  if (!old) index.documents.unshift(rec);
  return rec;
}

function shouldSkip(rec, meta, currentPath) {
  return Boolean(
    rec &&
    Number(rec.organizerVersion || 0) >= ORGANIZER_VERSION &&
    rec.lastProcessedModifiedTime && meta.modifiedTime &&
    rec.lastProcessedModifiedTime === meta.modifiedTime &&
    rec.organizedName === meta.name &&
    rec.organizedPath === currentPath &&
    !rec.needsReview
  );
}

function refreshCounters(index) {
  const docs = index.documents || [];
  const set = (id, value) => { const el = document.querySelector(id); if (el) el.textContent = value; };
  set('#statDocs', docs.length);
  set('#statReview', docs.filter(x => x.needsReview).length);
  set('#statProperties', new Set(docs.filter(x => x.entityType === 'property' && x.entityName).map(x => String(x.entityName).toLowerCase())).size);
  set('#statCompanies', new Set(docs.filter(x => x.entityType === 'company' && x.entityName).map(x => String(x.entityName).toLowerCase())).size);
}

function showReport(r) {
  document.querySelector('#poOrganizeReport')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'poOrganizeReport';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(20,20,18,.34);backdrop-filter:blur(8px);display:flex;align-items:flex-end;justify-content:center;padding:14px';
  const rows = r.changes.slice(0, 12).map(x => `
    <div style="padding:10px 0;border-top:1px solid #ece9e1">
      <b style="display:block;font-size:12px">${esc(x.newName)}</b>
      <small style="display:block;color:#7b786f;margin-top:3px;line-height:1.4">${esc(x.renamed ? `Renamed from ${x.oldName}` : 'Name unchanged')}${x.moved ? ` · Moved to ${x.toPath}` : ''}</small>
    </div>`).join('');

  wrap.innerHTML = `
    <div style="width:min(620px,100%);max-height:82vh;overflow:auto;background:#fff;border-radius:26px 26px 18px 18px;padding:22px;box-shadow:0 30px 100px rgba(0,0,0,.22);font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
        <div><div style="font-size:9px;letter-spacing:.16em;color:#8c877c">PRIVATE OFFICE</div><h2 style="font:500 28px/1.05 Georgia,serif;margin:7px 0 5px">Drive organized.</h2><p style="margin:0;color:#77746c;font-size:11px">Only real changes are counted below.</p></div>
        <button id="poCloseReport" style="width:36px;height:36px;border:1px solid #e6e3dc;background:#fff;border-radius:12px;font-size:18px">×</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:18px 0">
        <div style="background:#f7f7f3;border-radius:14px;padding:12px"><small style="color:#77746c">Renamed</small><b style="display:block;font:22px Georgia;margin-top:4px">${r.renamed}</b></div>
        <div style="background:#f7f7f3;border-radius:14px;padding:12px"><small style="color:#77746c">Moved</small><b style="display:block;font:22px Georgia;margin-top:4px">${r.moved}</b></div>
        <div style="background:#f7f7f3;border-radius:14px;padding:12px"><small style="color:#77746c">Classified</small><b style="display:block;font:22px Georgia;margin-top:4px">${r.classified}</b></div>
        <div style="background:#f7f7f3;border-radius:14px;padding:12px"><small style="color:#77746c">AI reads</small><b style="display:block;font:22px Georgia;margin-top:4px">${r.aiCalls}</b></div>
      </div>
      ${rows || '<div style="padding:14px;background:#f7f7f3;border-radius:14px;font-size:11px;color:#6f6c64">Everything Private Office already knew was already in the correct place.</div>'}
      <div style="display:flex;gap:8px;margin-top:16px">
        <a href="https://drive.google.com/drive/folders/${encodeURIComponent(r.rootId)}" target="_blank" rel="noopener" style="flex:1;text-align:center;text-decoration:none;background:#1d1d1a;color:white;border-radius:12px;padding:11px;font-size:11px;font-weight:700">Open organized Drive</a>
        <button id="poRefreshMemory" style="flex:1;background:#fff;border:1px solid #d8d4cb;border-radius:12px;padding:11px;font-size:11px;font-weight:700">Refresh memory</button>
      </div>
      <p style="font-size:9px;color:#99958b;margin:12px 0 0">${r.rules} zero-token rule${r.rules === 1 ? '' : 's'} · ${r.reused} reused classifications · ${r.skipped} skipped/deferred.</p>
    </div>`;

  document.body.appendChild(wrap);
  wrap.querySelector('#poCloseReport').onclick = () => wrap.remove();
  wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
  wrap.querySelector('#poRefreshMemory').onclick = () => location.reload();
}

async function organizeDrive({ interactive = true, recentOnly = false } = {}) {
  if (S.running) return;
  S.running = true;
  setOrganizeLabels();
  document.querySelectorAll('[data-action="sync"]').forEach(b => b.disabled = true);

  let aiCalls = 0;
  let rules = 0;
  let reused = 0;
  let skipped = 0;
  let classified = 0;
  let renamed = 0;
  let moved = 0;
  const changes = [];

  try {
    await getToken(interactive);
    status('Opening Private Office filing system…');

    const ws = await workspace(interactive);
    const folders = await folderMap(interactive);
    const files = await listAll("trashed=false and mimeType!='application/vnd.google-apps.folder'", 'id,name,mimeType,webViewLink,modifiedTime,size,parents', interactive);
    const byId = new Map(ws.index.documents.map(r => [r.driveId, r]));
    const knownIds = new Set(byId.keys());
    const ignore = new Set([ws.indexFileId]);

    for (const f of files) {
      if (f.name === 'private-office-vault.enc.json' && isBelow(f, ws.systemId, folders)) ignore.add(f.id);
    }

    let candidates = files.filter(f => {
      if (ignore.has(f.id)) return false;
      if (isBelow(f, ws.systemId, folders)) return false;
      return isBelow(f, ws.rootId, folders) || knownIds.has(f.id);
    });

    candidates.sort((a, b) => {
      const ar = byId.get(a.id), br = byId.get(b.id);
      const ap = (!ar || ar.needsReview || Number(ar.organizerVersion || 0) < ORGANIZER_VERSION) ? 1 : 0;
      const bp = (!br || br.needsReview || Number(br.organizerVersion || 0) < ORGANIZER_VERSION) ? 1 : 0;
      return bp - ap || String(b.modifiedTime).localeCompare(String(a.modifiedTime));
    });

    if (recentOnly) candidates = candidates.slice(0, 20);

    let inspected = 0;
    for (const meta of candidates) {
      if (inspected >= MAX_FILES_PER_RUN) break;
      inspected++;
      const rec = byId.get(meta.id);
      const currentPath = pathFor(meta, folders);
      if (shouldSkip(rec, meta, currentPath)) continue;

      status(`Organizing ${inspected}/${Math.min(candidates.length, MAX_FILES_PER_RUN)} · ${meta.name}`);

      let c = null;
      let source = '';

      if (reusableRecord(rec) && !rec.needsReview) {
        c = classificationFromRecord(rec, meta);
        source = 'reused';
        reused++;
      } else {
        c = ruleClassification(meta, currentPath);
        if (c) {
          source = 'rules';
          rules++;
        }
      }

      if (!c) {
        if (aiCalls >= MAX_AI_PER_RUN) {
          skipped++;
          continue;
        }
        try {
          const response = await aiClassify(meta, currentPath, interactive);
          c = response.classification;
          source = c?.ai_used === false ? 'rules' : 'ai';
          if (source === 'ai') aiCalls++;
          else rules++;
        } catch (e) {
          console.info('Private Office could not classify', meta.name, e.message);
          skipped++;
          continue;
        }
      }

      classified++;

      try {
        const dest = await destination(ws, c, interactive);
        const change = await mutateFile(meta, c, dest, interactive);
        upsert(ws.index, rec, meta, change.meta, c, dest.path, source);
        byId.set(meta.id, ws.index.documents.find(x => x.driveId === meta.id));

        if (change.renamed) renamed++;
        if (change.moved) moved++;
        if (change.renamed || change.moved) {
          changes.push({
            oldName: change.oldName,
            newName: change.newName,
            renamed: change.renamed,
            moved: change.moved,
            fromPath: currentPath,
            toPath: dest.path
          });
        }
      } catch (e) {
        console.info('Private Office could not file', meta.name, e.message);
        skipped++;
      }
    }

    ws.index.updatedAt = new Date().toISOString();
    ws.index.organizerVersion = ORGANIZER_VERSION;
    await writeJsonFile(ws.indexFileId, ws.index, interactive);
    refreshCounters(ws.index);

    const realChanges = renamed + moved;
    status(realChanges
      ? `Google Drive · ${renamed} renamed · ${moved} moved`
      : 'Google Drive · already organized');

    toast(realChanges
      ? `${renamed} renamed · ${moved} moved · ${aiCalls} AI read${aiCalls === 1 ? '' : 's'}`
      : `No file moves needed · ${classified} classifications checked`);

    if (interactive) {
      showReport({ rootId: ws.rootId, renamed, moved, classified, aiCalls, rules, reused, skipped, changes });
    }
  } catch (e) {
    status('Google Drive · private memory ready');
    if (interactive) toast(e.message);
    else console.info('Private Office background organizer:', e.message);
  } finally {
    S.running = false;
    document.querySelectorAll('[data-action="sync"]').forEach(b => b.disabled = false);
  }
}

// Replace the old lightweight Index Drive action with the full organizer.
document.addEventListener('click', e => {
  const button = e.target.closest?.('[data-action="sync"]');
  if (!button) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  organizeDrive({ interactive: true });
}, true);

// Newly uploaded files are organized automatically while the Drive session is active.
const observer = new MutationObserver(() => {
  const modal = document.querySelector('#uploadModal');
  if (!modal) return;
  const open = !modal.classList.contains('hidden');
  if (S.uploadWasOpen && !open && (S.accessToken || cachedToken())) {
    setTimeout(() => organizeDrive({ interactive: false, recentOnly: true }), 1200);
  }
  S.uploadWasOpen = open;
});

window.addEventListener('load', () => {
  setOrganizeLabels();
  const modal = document.querySelector('#uploadModal');
  if (modal) {
    S.uploadWasOpen = !modal.classList.contains('hidden');
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
  }
});

window.PrivateOfficeOrganizer = {
  organize: () => organizeDrive({ interactive: true })
};
})();
