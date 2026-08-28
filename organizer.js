(() => {
'use strict';

const C = window.PRIVATE_OFFICE_CONFIG || {};
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const ROOT = C.ROOT_FOLDER || 'Private Office';
const ORGANIZER_VERSION = 4;
const MAX_AI_PER_RUN = 8;
const MAX_FILES_PER_RUN = 80;
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
const safe = s => String(s || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
const qName = s => String(s || '').replace(/'/g, "\\'");
const extOf = name => { const m = String(name || '').match(/(\.[A-Za-z0-9]{1,8})$/); return m ? m[1].toLowerCase() : ''; };
const baseOf = name => extOf(name) ? String(name).slice(0, -extOf(name).length) : String(name || 'Document');
const titleCase = s => String(s || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
const cleanBase = name => safe(baseOf(name).replace(/[_]+/g, ' ').replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' '));

function toast(message) {
  const t = document.querySelector('#toast');
  if (!t) return;
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

function status(message) {
  const el = document.querySelector('#syncState');
  if (el) el.textContent = message;
}

function setOrganizeLabels() {
  document.querySelectorAll('[data-action="sync"]').forEach(b => {
    if (/index drive/i.test(b.textContent || '')) b.textContent = 'Organize Drive';
    b.title = 'Classify, rename and file Drive documents';
  });
}

function initTokenClient() {
  if (S.tokenClient || !window.google?.accounts?.oauth2) return;
  S.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: C.GOOGLE_CLIENT_ID,
    scope: 'openid email profile https://www.googleapis.com/auth/drive',
    callback: r => {
      const waiter = S.tokenWaiter;
      S.tokenWaiter = null;
      if (!waiter) return;
      if (r.error) waiter.reject(new Error(r.error_description || r.error));
      else {
        S.accessToken = r.access_token;
        waiter.resolve(r.access_token);
      }
    }
  });
}

async function getToken(interactive = true) {
  if (S.accessToken) return S.accessToken;
  for (let i = 0; i < 50 && !window.google?.accounts?.oauth2; i++) await sleep(100);
  initTokenClient();
  if (!S.tokenClient) throw new Error('Google Drive authorization is not ready');
  return new Promise((resolve, reject) => {
    S.tokenWaiter = { resolve, reject };
    S.tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
  });
}

async function driveFetch(url, opts = {}, retry = true, interactive = true) {
  await getToken(interactive);
  const headers = { ...(opts.headers || {}), Authorization: `Bearer ${S.accessToken}` };
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401 && retry) {
    S.accessToken = null;
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

async function listAll(q, fields, interactive = true) {
  const out = [];
  let pageToken = '';
  do {
    const u = `${DRIVE}/files?q=${encodeURIComponent(q)}&spaces=drive&pageSize=1000&fields=${encodeURIComponent(`nextPageToken,files(${fields})`)}` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const d = await driveJson(u, {}, interactive);
    out.push(...(d.files || []));
    pageToken = d.nextPageToken || '';
  } while (pageToken && out.length < 5000);
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
  let idx = await driveJson(`${DRIVE}/files?q=${encodeURIComponent(`'${systemId}' in parents and name='private-office-index.json' and trashed=false`)}&spaces=drive&pageSize=10&fields=files(id,name)`, {}, interactive);
  let indexFileId = idx.files?.[0]?.id;
  if (!indexFileId) {
    const meta = await driveJson(`${DRIVE}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'private-office-index.json', mimeType: 'application/json', parents: [systemId] })
    }, interactive);
    indexFileId = meta.id;
    await writeJsonFile(indexFileId, { version: 1, updatedAt: null, documents: [] }, interactive);
  }
  let index;
  try { index = await readJsonFile(indexFileId, interactive); }
  catch { index = { version: 1, updatedAt: null, documents: [] }; }
  if (!Array.isArray(index.documents)) index.documents = [];
  return { rootId, systemId, indexFileId, index };
}

function normalizedFilename(existing, desired) {
  const ext = extOf(existing);
  let b = safe(baseOf(desired || existing));
  b = b.replace(/\s+/g, ' ').replace(/^[-_. ]+|[-_. ]+$/g, '').slice(0, 110) || cleanBase(existing) || 'Document';
  return `${b}${ext}`;
}

function ruleClassification(meta, path = '') {
  const n = `${meta.name || ''} ${path || ''}`.toLowerCase().replace(/[_-]+/g, ' ');
  const ext = extOf(meta.name);
  const clean = cleanBase(meta.name);
  const result = (category, type, title, entityType = null, entityName = null, suggested = null) => ({
    document_type: type,
    category,
    title: title || clean,
    summary: `${type} identified from the filename and Drive context.`,
    search_text: `${clean} ${path}`.trim().slice(0, 260),
    document_date: null,
    expiry_date: null,
    linked_entity_type: entityType,
    linked_entity_name: entityName,
    parties: [],
    tags: [type.toLowerCase()].slice(0, 5),
    sensitivity: 'normal',
    confidence: 0.98,
    needs_review: false,
    suggested_filename: suggested || `${titleCase(clean)}${ext}`,
    ai_used: false,
    classification_source: 'rules'
  });

  if (/\b(account|bank)\s+statement\b|statement\s*\d{2,}/.test(n)) return result('Banking', 'Account Statement', 'Account Statement', 'banking', null, `${titleCase(clean)}${ext}`);
  if (/\b(certificate of occupancy|c\s*of\s*o|right of occupancy|deed of assignment|deed of conveyance|survey plan|land title|allocation letter|plot allocation)\b/.test(n)) return result('Properties', 'Property Title Document', clean, 'property');
  if (/\b(cac|certificate of incorporation|incorporation|memorandum and articles|memart|company registration|rc\s*\d+)\b/.test(n)) return result('Companies', 'Company Registration Document', clean, 'company');
  if (/\b(passport|national id|national identification|\bnin\b|birth certificate|drivers? licence|drivers? license)\b/.test(n)) return result('Personal', 'Identity Document', clean, 'person');
  if (/\b(invoice|payment receipt|bank receipt|transfer receipt|remittance)\b/.test(n)) return result('Banking', /invoice/.test(n) ? 'Invoice' : 'Payment Receipt', clean, 'banking');
  if (/\b(quotation|quotations|price quote|purchase order|proposal)\b/.test(n)) return result('Companies', /proposal/.test(n) ? 'Business Proposal' : 'Quotation', clean, 'company');
  if (/\b(vehicle registration|roadworthiness|vehicle licence|vehicle license|car registration)\b/.test(n)) return result('Vehicles', 'Vehicle Document', clean, 'vehicle');
  if (/\b(insurance policy|insurance certificate|insurance renewal)\b/.test(n)) return result('Insurance', 'Insurance Document', clean, 'insurance');
  if (/\b(share certificate|investment statement|portfolio statement|dividend|stock statement)\b/.test(n)) return result('Investments', 'Investment Document', clean, 'investment');
  if (/\b(tax clearance|tax return|\bfirs\b|\bvat\b|tax assessment)\b/.test(n)) return result('Taxes', 'Tax Document', clean, 'tax');
  if (/\b(nda|non disclosure|contract|legal agreement|tenancy agreement|lease agreement|affidavit|court order)\b/.test(n)) return result('Legal', 'Legal Agreement', clean, 'legal');
  return null;
}

function reusableRecord(rec) {
  if (!rec) return false;
  const placeholder = /uploaded but ai classification needs review|not yet been fully classified/i.test(`${rec.summary || ''}`);
  return !placeholder && Number(rec.confidence || 0) >= 0.88 && rec.category && rec.category !== 'Other' && rec.documentType && rec.searchText;
}

async function getContent(meta, interactive = true) {
  let url, type = meta.mimeType || 'application/octet-stream', name = meta.name;
  if (type === 'application/vnd.google-apps.document') {
    url = `${DRIVE}/files/${meta.id}/export?mimeType=${encodeURIComponent('text/plain')}`; type = 'text/plain'; name += '.txt';
  } else if (type === 'application/vnd.google-apps.spreadsheet') {
    url = `${DRIVE}/files/${meta.id}/export?mimeType=${encodeURIComponent('text/csv')}`; type = 'text/csv'; name += '.csv';
  } else if (type === 'application/vnd.google-apps.presentation') {
    url = `${DRIVE}/files/${meta.id}/export?mimeType=${encodeURIComponent('application/pdf')}`; type = 'application/pdf'; name += '.pdf';
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
    body: JSON.stringify({ action: 'classify', name: f.name, mime: f.type, base64, current_path: path, organizer: true })
  });
  let d = {};
  try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(d.error || `AI classification failed (${r.status})`);
  return { classification: d.classification, usage: d.usage || null };
}

async function folderMap(interactive = true) {
  const folders = await listAll("trashed=false and mimeType='application/vnd.google-apps.folder'", 'id,name,parents', interactive);
  const map = new Map(folders.map(f => [f.id, f]));
  return map;
}

function pathFor(meta, folders) {
  const names = [];
  let id = meta.parents?.[0];
  const seen = new Set();
  while (id && folders.has(id) && !seen.has(id) && names.length < 6) {
    seen.add(id);
    const f = folders.get(id);
    names.unshift(f.name);
    id = f.parents?.[0];
  }
  return names.join(' / ');
}

async function destination(ws, c, interactive = true) {
  if (c.sensitivity === 'vault_forbidden' || c.needs_review || Number(c.confidence || 0) < 0.82) {
    return { id: await ensureFolder('Needs Review', ws.rootId, interactive), path: `${ROOT} / Needs Review` };
  }
  const categoryName = CATEGORY_FOLDER[c.category] || 'Other';
  const categoryId = await ensureFolder(categoryName, ws.rootId, interactive);
  if (c.linked_entity_name) {
    const entity = safe(c.linked_entity_name);
    if (entity) return { id: await ensureFolder(entity, categoryId, interactive), path: `${ROOT} / ${categoryName} / ${entity}` };
  }
  return { id: categoryId, path: `${ROOT} / ${categoryName}` };
}

async function mutateFile(meta, c, dest, interactive = true) {
  const newName = c.sensitivity === 'vault_forbidden' ? meta.name : normalizedFilename(meta.name, c.suggested_filename || c.title || meta.name);
  const currentParents = meta.parents || [];
  const alreadyThere = currentParents.includes(dest.id);
  const sameName = newName === meta.name;
  if (alreadyThere && sameName) return { ...meta, name: newName };

  let url = `${DRIVE}/files/${encodeURIComponent(meta.id)}?fields=id,name,mimeType,webViewLink,modifiedTime,size,parents`;
  if (!alreadyThere) {
    url += `&addParents=${encodeURIComponent(dest.id)}`;
    if (currentParents.length) url += `&removeParents=${encodeURIComponent(currentParents.join(','))}`;
  }
  return driveJson(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sameName ? {} : { name: newName })
  }, interactive);
}

function upsert(index, old, metaBefore, metaAfter, c, destPath, source) {
  const now = new Date().toISOString();
  const rec = old || { id: crypto.randomUUID(), indexedAt: now };
  const originalName = rec.originalName || metaBefore.name;
  Object.assign(rec, {
    driveId: metaAfter.id,
    name: metaAfter.name,
    originalName,
    title: c.title || cleanBase(metaAfter.name),
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
    driveUrl: metaAfter.webViewLink || `https://drive.google.com/open?id=${metaAfter.id}`,
    drivePath: destPath,
    existingDrive: true,
    modifiedTime: metaAfter.modifiedTime || metaBefore.modifiedTime || null,
    lastProcessedModifiedTime: metaAfter.modifiedTime || metaBefore.modifiedTime || null,
    organizerVersion: ORGANIZER_VERSION,
    classificationSource: source,
    aiUsed: Boolean(c.ai_used || source === 'ai'),
    lastOrganizedAt: now
  });
  if (!old) index.documents.unshift(rec);
  return rec;
}

function shouldSkip(rec, meta) {
  return Boolean(rec && Number(rec.organizerVersion || 0) >= ORGANIZER_VERSION && rec.lastProcessedModifiedTime && meta.modifiedTime && rec.lastProcessedModifiedTime === meta.modifiedTime && !rec.needsReview);
}

async function organizeDrive({ interactive = true, recentOnly = false } = {}) {
  if (S.running) return;
  S.running = true;
  setOrganizeLabels();
  document.querySelectorAll('[data-action="sync"]').forEach(b => b.disabled = true);

  let aiCalls = 0, organized = 0, skipped = 0, rules = 0, reused = 0;
  try {
    await getToken(interactive);
    status('Opening Private Office filing system…');
    const ws = await workspace(interactive);
    const folders = await folderMap(interactive);
    const files = await listAll("trashed=false and mimeType!='application/vnd.google-apps.folder'", 'id,name,mimeType,webViewLink,modifiedTime,size,parents', interactive);
    const byId = new Map(ws.index.documents.map(r => [r.driveId, r]));
    const ignore = new Set([ws.indexFileId]);
    const vault = files.find(f => f.name === 'private-office-vault.enc.json' && f.parents?.includes(ws.systemId));
    if (vault) ignore.add(vault.id);

    let candidates = files.filter(f => !ignore.has(f.id));
    if (recentOnly) candidates = candidates.sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime))).slice(0, 20);
    else {
      candidates.sort((a, b) => {
        const ar = byId.get(a.id), br = byId.get(b.id);
        const ap = ar?.needsReview || !ar ? 1 : 0;
        const bp = br?.needsReview || !br ? 1 : 0;
        return bp - ap || String(b.modifiedTime).localeCompare(String(a.modifiedTime));
      });
    }

    let inspected = 0;
    for (const meta of candidates) {
      if (inspected >= MAX_FILES_PER_RUN) break;
      inspected++;
      const rec = byId.get(meta.id);
      if (shouldSkip(rec, meta)) continue;

      const currentPath = pathFor(meta, folders);
      status(`Organizing · ${meta.name}`);
      let c = null, source = '';

      if (reusableRecord(rec) && !rec.needsReview) {
        c = {
          document_type: rec.documentType, category: rec.category, title: rec.title,
          summary: rec.summary, search_text: rec.searchText, document_date: rec.documentDate || null,
          expiry_date: rec.expiryDate || null, linked_entity_type: rec.entityType || null,
          linked_entity_name: rec.entityName || null, parties: rec.parties || [], tags: rec.tags || [],
          sensitivity: rec.sensitivity || 'normal', confidence: Number(rec.confidence || .9),
          needs_review: Boolean(rec.needsReview), suggested_filename: rec.name, ai_used: Boolean(rec.aiUsed)
        };
        source = 'reused'; reused++;
      } else {
        c = ruleClassification(meta, currentPath);
        if (c) { source = 'rules'; rules++; }
      }

      if (!c) {
        if (aiCalls >= MAX_AI_PER_RUN) { skipped++; continue; }
        try {
          const r = await aiClassify(meta, currentPath, interactive);
          c = r.classification;
          source = c?.ai_used === false ? 'rules' : 'ai';
          if (source === 'ai') aiCalls++;
          else rules++;
        } catch (e) {
          console.info('Private Office could not classify', meta.name, e.message);
          skipped++;
          continue;
        }
      }

      try {
        const dest = await destination(ws, c, interactive);
        const changed = await mutateFile(meta, c, dest, interactive);
        upsert(ws.index, rec, meta, changed, c, dest.path, source);
        byId.set(meta.id, ws.index.documents.find(x => x.driveId === meta.id));
        organized++;
      } catch (e) {
        console.info('Private Office could not file', meta.name, e.message);
        skipped++;
      }
    }

    ws.index.updatedAt = new Date().toISOString();
    ws.index.organizerVersion = ORGANIZER_VERSION;
    await writeJsonFile(ws.indexFileId, ws.index, interactive);

    const parts = [`${organized} organized`];
    if (aiCalls) parts.push(`${aiCalls} AI read${aiCalls === 1 ? '' : 's'}`);
    if (rules) parts.push(`${rules} zero-token rule${rules === 1 ? '' : 's'}`);
    if (reused) parts.push(`${reused} reused`);
    toast(parts.join(' · '));
    if (skipped) console.info('Private Office deferred/skipped', skipped, 'files');
    status('Google Drive · organized private memory');

    await sleep(900);
    location.reload();
  } catch (e) {
    status('Google Drive · private memory ready');
    toast(e.message);
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

// Once full Drive permission has been granted, newly uploaded files are renamed/filed automatically.
const observer = new MutationObserver(() => {
  const modal = document.querySelector('#uploadModal');
  if (!modal) return;
  const open = !modal.classList.contains('hidden');
  if (S.uploadWasOpen && !open && S.accessToken) {
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

window.PrivateOfficeOrganizer = { organize: () => organizeDrive({ interactive: true }) };
})();
