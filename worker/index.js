const OPENAI = 'https://api.openai.com/v1';
const DEFAULT_GOOGLE_CLIENT_ID = '785030760124-2f54hqcimk7t4kptp8ku1se21hs9f528.apps.googleusercontent.com';
let jwksCache = { at: 0, keys: [] };

function normalizeOrigin(value) {
  try { return new URL(String(value || '').trim()).origin; }
  catch { return String(value || '').trim().replace(/\/$/, ''); }
}
function allowedOrigins(env) { return String(env.APP_ORIGINS || 'https://kingamada.github.io').split(',').map(normalizeOrigin).filter(Boolean); }
function originAllowed(origin, env) { return allowedOrigins(env).includes(normalizeOrigin(origin)); }
function googleClientId(env) { return String(env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID).trim(); }
function cors(origin, env) {
  const clean = normalizeOrigin(origin), ok = originAllowed(clean, env);
  return {
    'Access-Control-Allow-Origin': ok ? clean : 'null',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Content-Type': 'application/json'
  };
}
function json(data, status, origin, env) { return new Response(JSON.stringify(data), { status, headers: cors(origin, env) }); }

function b64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function parseJwt(t) {
  const [h, p, s] = t.split('.');
  if (!h || !p || !s) throw new Error('Malformed identity token');
  return {
    header: JSON.parse(new TextDecoder().decode(b64url(h))),
    payload: JSON.parse(new TextDecoder().decode(b64url(p))),
    sig: b64url(s),
    data: new TextEncoder().encode(`${h}.${p}`)
  };
}
async function jwks() {
  if (Date.now() - jwksCache.at < 3_000_000 && jwksCache.keys.length) return jwksCache.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('Could not load Google signing keys');
  const d = await r.json();
  jwksCache = { at: Date.now(), keys: d.keys || [] };
  return jwksCache.keys;
}
async function verifyGoogle(token, env) {
  const j = parseJwt(token), keys = await jwks(), jwk = keys.find(k => k.kid === j.header.kid);
  if (!jwk) throw new Error('Unknown Google signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, j.sig, j.data);
  if (!valid) throw new Error('Invalid Google signature');
  const p = j.payload, now = Math.floor(Date.now() / 1000);
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(p.iss) || p.aud !== googleClientId(env) || Number(p.exp) < now) throw new Error('Expired or invalid Google identity');
  if (!(p.email_verified === true || p.email_verified === 'true')) throw new Error('Google email is not verified');
  const allowed = String(env.ALLOWED_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(p.email || '').toLowerCase())) throw new Error('This Google account is not authorized');
  return p;
}
async function safetyId(email) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(email || 'private-office')));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
function outputText(d) {
  if (typeof d.output_text === 'string') return d.output_text;
  for (const item of d.output || []) for (const c of item.content || []) if (c.type === 'output_text' && c.text) return c.text;
  return '';
}
async function openai(path, env, opts = {}) {
  const r = await fetch(OPENAI + path, { ...opts, headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, ...(opts.headers || {}) } });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json())?.error?.message || ''; } catch {}
    throw new Error(detail || `OpenAI request failed (${r.status})`);
  }
  return r;
}

function extOf(name) { const m = String(name || '').match(/(\.[A-Za-z0-9]{1,8})$/); return m ? m[1].toLowerCase() : ''; }
function baseOf(name) { const ext = extOf(name); return ext ? String(name).slice(0, -ext.length) : String(name || 'Document'); }
function safeText(s, max = 220) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function cleanBase(name) { return safeText(baseOf(name).replace(/[_]+/g, ' ').replace(/\s*-\s*/g, ' - '), 110); }
function titleCase(s) { return String(s || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()); }
function normalizedSuggested(name) { return `${titleCase(cleanBase(name))}${extOf(name)}`; }

function ruleClassification(name, mime = '', currentPath = '') {
  const n = `${name || ''} ${currentPath || ''}`.toLowerCase().replace(/[_-]+/g, ' ');
  const clean = cleanBase(name);
  const suggested = normalizedSuggested(name);
  const make = (category, documentType, title, entityType = null, entityName = null) => ({
    suggested_filename: suggested,
    document_type: documentType,
    category,
    title: safeText(title || clean, 120),
    summary: safeText(`${documentType} identified from its filename and Drive context.`, 160),
    search_text: safeText(`${clean} ${currentPath}`, 280),
    document_date: null,
    expiry_date: null,
    linked_entity_type: entityType,
    linked_entity_name: entityName,
    parties: [],
    tags: [documentType.toLowerCase()],
    sensitivity: 'normal',
    confidence: 0.98,
    needs_review: false,
    ai_used: false,
    classification_source: 'rules'
  });

  if (/\b(account|bank)\s+statement\b|statement\s*\d{2,}/.test(n)) return make('Banking', 'Account Statement', 'Account Statement', 'banking');
  if (/\b(certificate of occupancy|c\s*of\s*o|right of occupancy|deed of assignment|deed of conveyance|survey plan|land title|allocation letter|plot allocation)\b/.test(n)) return make('Properties', 'Property Title Document', clean, 'property');
  if (/\b(cac|certificate of incorporation|incorporation|memorandum and articles|memart|company registration|rc\s*\d+)\b/.test(n)) return make('Companies', 'Company Registration Document', clean, 'company');
  if (/\b(passport|national id|national identification|\bnin\b|birth certificate|drivers? licence|drivers? license)\b/.test(n)) return make('Personal', 'Identity Document', clean, 'person');
  if (/\b(invoice|payment receipt|bank receipt|transfer receipt|remittance)\b/.test(n)) return make('Banking', /invoice/.test(n) ? 'Invoice' : 'Payment Receipt', clean, 'banking');
  if (/\b(quotation|quotations|price quote|purchase order|proposal)\b/.test(n)) return make('Companies', /proposal/.test(n) ? 'Business Proposal' : 'Quotation', clean, 'company');
  if (/\b(vehicle registration|roadworthiness|vehicle licence|vehicle license|car registration)\b/.test(n)) return make('Vehicles', 'Vehicle Document', clean, 'vehicle');
  if (/\b(insurance policy|insurance certificate|insurance renewal)\b/.test(n)) return make('Insurance', 'Insurance Document', clean, 'insurance');
  if (/\b(share certificate|investment statement|portfolio statement|dividend|stock statement)\b/.test(n)) return make('Investments', 'Investment Document', clean, 'investment');
  if (/\b(tax clearance|tax return|\bfirs\b|\bvat\b|tax assessment)\b/.test(n)) return make('Taxes', 'Tax Document', clean, 'tax');
  if (/\b(nda|non disclosure|contract|legal agreement|tenancy agreement|lease agreement|affidavit|court order)\b/.test(n)) return make('Legal', 'Legal Agreement', clean, 'legal');
  return null;
}

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    suggested_filename: { type: 'string' },
    document_type: { type: 'string' },
    category: { type: 'string', enum: ['Properties', 'Companies', 'Banking', 'Personal', 'Legal', 'Vehicles', 'Insurance', 'Investments', 'Taxes', 'Other'] },
    title: { type: 'string' },
    summary: { type: 'string' },
    search_text: { type: 'string' },
    document_date: { type: ['string', 'null'] },
    expiry_date: { type: ['string', 'null'] },
    linked_entity_type: { type: ['string', 'null'], enum: ['property', 'company', 'person', 'banking', 'vehicle', 'investment', 'legal', 'insurance', 'tax', 'other', null] },
    linked_entity_name: { type: ['string', 'null'] },
    parties: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    sensitivity: { type: 'string', enum: ['normal', 'sensitive', 'vault_forbidden'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    needs_review: { type: 'boolean' }
  },
  required: ['suggested_filename', 'document_type', 'category', 'title', 'summary', 'search_text', 'document_date', 'expiry_date', 'linked_entity_type', 'linked_entity_name', 'parties', 'tags', 'sensitivity', 'confidence', 'needs_review']
};

function compactClassification(c, originalName) {
  const out = { ...c };
  out.suggested_filename = safeText(out.suggested_filename || normalizedSuggested(originalName), 120);
  out.document_type = safeText(out.document_type || 'Document', 70);
  out.title = safeText(out.title || cleanBase(originalName), 120);
  out.summary = safeText(out.summary, 180);
  out.search_text = safeText(out.search_text, 320);
  out.linked_entity_name = out.linked_entity_name ? safeText(out.linked_entity_name, 90) : null;
  out.parties = (out.parties || []).map(x => safeText(x, 70)).filter(Boolean).slice(0, 5);
  out.tags = (out.tags || []).map(x => safeText(x, 35)).filter(Boolean).slice(0, 5);
  return out;
}

async function classify(body, user, env) {
  const rule = ruleClassification(body.name, body.mime, body.current_path);
  if (rule && !body.force_ai) return { classification: rule, usage: { ai_used: false, input_tokens: 0, output_tokens: 0, total_tokens: 0 } };

  const raw = Uint8Array.from(atob(body.base64 || ''), c => c.charCodeAt(0));
  if (!raw.length) throw new Error('No file content supplied');
  if (raw.byteLength > 10 * 1024 * 1024) throw new Error('File is too large for the AI gateway');

  const form = new FormData();
  form.append('purpose', 'user_data');
  form.append('file', new File([raw], body.name || 'document', { type: body.mime || 'application/octet-stream' }));
  const up = await (await openai('/files', env, { method: 'POST', body: form })).json();

  try {
    const req = {
      model: env.OPENAI_MODEL || 'gpt-5.6-luna',
      store: false,
      safety_identifier: await safetyId(user.email),
      prompt_cache_key: 'private-office-classifier-v4',
      reasoning: { effort: 'none' },
      max_output_tokens: 520,
      instructions: `Classify one private-office document. Be terse. Also propose a clean human filename that preserves meaning but not secret values. Summary: max 25 words. Search text: max 45 words. Max 5 tags and 5 parties. Never expose passwords, OTPs, CVVs, PINs, seed/recovery phrases, private keys or authentication codes. If any appear, set sensitivity=vault_forbidden and needs_review=true and omit the secret values. Do not invent names, dates, ownership or entities.`,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: `Filename: ${body.name || 'document'}\nCurrent Drive path: ${safeText(body.current_path || '', 300)}\nMIME: ${body.mime || 'unknown'}\nReturn classification only.` },
          { type: 'input_file', file_id: up.id }
        ]
      }],
      text: { format: { type: 'json_schema', name: 'private_office_document_v4', strict: true, schema }, verbosity: 'low' }
    };

    const d = await (await openai('/responses', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    })).json();

    const parsed = compactClassification(JSON.parse(outputText(d)), body.name);
    parsed.ai_used = true;
    parsed.classification_source = 'ai';
    return {
      classification: parsed,
      usage: {
        ai_used: true,
        input_tokens: Number(d.usage?.input_tokens || 0),
        cached_tokens: Number(d.usage?.input_tokens_details?.cached_tokens || 0),
        output_tokens: Number(d.usage?.output_tokens || 0),
        total_tokens: Number(d.usage?.total_tokens || 0)
      }
    };
  } finally {
    try { await openai(`/files/${encodeURIComponent(up.id)}`, env, { method: 'DELETE' }); } catch {}
  }
}

async function chat(body, user, env) {
  const records = (body.records || []).slice(0, 8).map(r => ({
    title: safeText(r.title, 120),
    name: safeText(r.name, 120),
    category: r.category,
    documentType: r.documentType,
    entityType: r.entityType,
    entityName: safeText(r.entityName, 90),
    summary: safeText(r.summary, 180),
    searchText: safeText(r.searchText, 260),
    documentDate: r.documentDate,
    expiryDate: r.expiryDate,
    drivePath: safeText(r.drivePath, 180)
  }));

  const req = {
    model: env.OPENAI_MODEL || 'gpt-5.6-luna',
    store: false,
    safety_identifier: await safetyId(user.email),
    prompt_cache_key: 'private-office-chat-v3',
    reasoning: { effort: 'none' },
    max_output_tokens: 650,
    instructions: `You are Private Office, a discreet private chief of staff. Answer only from the supplied indexed records. Be concise. If the records do not support the answer, say you could not find it. Never reveal or infer passwords, PINs, CVVs, OTPs, seed/recovery phrases or private keys; direct credential questions to Private Vault.`,
    input: `QUESTION:\n${String(body.message || '').slice(0, 2500)}\n\nRECORDS:\n${JSON.stringify(records).slice(0, 24000)}`,
    text: { verbosity: 'low' }
  };

  const d = await (await openai('/responses', env, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req)
  })).json();
  return outputText(d) || 'I could not find a supported answer in the indexed records.';
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') {
      if (!originAllowed(origin, env)) return new Response(null, { status: 403, headers: cors(origin, env) });
      return new Response(null, { status: 204, headers: cors(origin, env) });
    }
    if (req.method === 'GET') return json({ ok: true, service: 'Private Office AI Gateway' }, 200, origin, env);
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin, env);
    if (!originAllowed(origin, env)) return json({ error: 'Origin not allowed' }, 403, origin, env);

    try {
      const missing = [];
      if (!env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
      if (!googleClientId(env)) missing.push('GOOGLE_CLIENT_ID');
      if (missing.length) throw new Error(`Missing runtime binding: ${missing.join(', ')}`);

      const auth = req.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401, origin, env);
      const user = await verifyGoogle(auth.slice(7), env);
      const body = await req.json();

      if (body.action === 'classify') {
        const r = await classify(body, user, env);
        return json(r, 200, origin, env);
      }
      if (body.action === 'chat') return json({ answer: await chat(body, user, env) }, 200, origin, env);
      return json({ error: 'Unknown action' }, 400, origin, env);
    } catch (e) {
      return json({ error: e.message || 'Gateway error' }, 500, origin, env);
    }
  }
};
