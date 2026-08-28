const OPENAI = 'https://api.openai.com/v1';

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    suggested_filename: { type: 'string' },
    document_type: { type: 'string' },
    category: {
      type: 'string',
      enum: ['Properties','Companies','Banking','Personal','Legal','Vehicles','Insurance','Investments','Taxes','Operations','Other']
    },
    title: { type: 'string' },
    summary: { type: 'string' },
    search_text: { type: 'string' },
    entity_name: { type: ['string','null'] },
    document_date: { type: ['string','null'] },
    expiry_date: { type: ['string','null'] }
  },
  required: [
    'suggested_filename','document_type','category','title','summary','search_text',
    'entity_name','document_date','expiry_date'
  ]
};

async function call(path, env, options = {}) {
  const r = await fetch(OPENAI + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      ...(options.headers || {})
    }
  });
  if (!r.ok) {
    let message = '';
    try { message = (await r.json())?.error?.message || ''; } catch {}
    throw new Error(message || `OpenAI request failed (${r.status})`);
  }
  return r;
}

function outputText(d) {
  if (typeof d.output_text === 'string') return d.output_text;
  for (const item of d.output || []) {
    for (const c of item.content || []) {
      if (c.type === 'output_text' && c.text) return c.text;
    }
  }
  return '';
}

function bytesToBase64(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < a.length; i += chunk) {
    binary += String.fromCharCode(...a.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function responseRequest(env, content) {
  return {
    model: env.OPENAI_MODEL || 'gpt-5.6-luna',
    store: false,
    prompt_cache_key: 'private-office-file-v3',
    reasoning: { effort: 'none' },
    max_output_tokens: 480,
    instructions:
      'Read this private-office item once and create compact filing memory. Be terse. ' +
      'Suggested filename must be human-readable and never contain passwords, PINs, CVVs, OTPs, ' +
      'recovery/seed phrases, private keys or authentication secrets. Summary max 28 words; ' +
      'search_text max 60 words. Use visible text when present. Do not invent names, dates, ownership or entities.',
    input: [{ role: 'user', content }],
    text: {
      format: { type: 'json_schema', name: 'private_office_file', strict: true, schema },
      verbosity: 'low'
    }
  };
}

export async function classify(env, bytes, file) {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');

  const name = file.name || 'document';
  const mime = file.type || 'application/octet-stream';
  const intro = {
    type: 'input_text',
    text: `Original filename: ${name}\nMIME: ${mime}\nReturn structured classification only.`
  };

  if (mime.startsWith('image/')) {
    const image = {
      type: 'input_image',
      image_url: `data:${mime};base64,${bytesToBase64(bytes)}`,
      detail: 'low'
    };
    const req = responseRequest(env, [intro, image]);
    const d = await (await call('/responses', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    })).json();
    return JSON.parse(outputText(d));
  }

  const fd = new FormData();
  fd.append('purpose', 'user_data');
  fd.append('file', new File([bytes], name, { type: mime }));
  const up = await (await call('/files', env, { method: 'POST', body: fd })).json();

  try {
    const req = responseRequest(env, [
      intro,
      { type: 'input_file', file_id: up.id }
    ]);
    const d = await (await call('/responses', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    })).json();
    return JSON.parse(outputText(d));
  } finally {
    try { await call(`/files/${encodeURIComponent(up.id)}`, env, { method: 'DELETE' }); } catch {}
  }
}

export async function answer(env, question, context) {
  if (!context.length) return 'I could not find anything relevant in Private Office yet.';
  const req = {
    model: env.OPENAI_MODEL || 'gpt-5.6-luna',
    store: false,
    prompt_cache_key: 'private-office-chat-v7',
    reasoning: { effort: 'none' },
    max_output_tokens: 520,
    instructions:
      'You are Private Office, a concise personal chief of staff. Answer only from the supplied private memory. ' +
      'Treat created_at timestamps and ordering as authoritative for words such as latest, last, recently and today. ' +
      'If unsupported, say so. Mention useful names/dates. Return plain text only: no Markdown, no asterisks, no headings, no bullet syntax. ' +
      'Never reveal or infer passwords, PINs, CVVs, OTPs, recovery/seed phrases or private keys.',
    input: `QUESTION:\n${String(question).slice(0,2500)}\n\nPRIVATE MEMORY:\n${JSON.stringify(context).slice(0,22000)}`,
    text: { verbosity: 'low' }
  };
  const d = await (await call('/responses', env, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req)
  })).json();
  return outputText(d) || 'I could not find a supported answer.';
}
