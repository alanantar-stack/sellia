import express from 'express';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));
app.get('/', (_req, res) => res.redirect('/index.html'));

const BASE_URL = (process.env.BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const API_KEY = process.env.API_KEY;
const MODEL = process.env.MODEL || 'nvidia/nemotron-3.5-lightning:free';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
// Supabase's current server-side key is SUPABASE_SECRET_KEY (sb_secret_...).
// SUPABASE_SERVICE_ROLE_KEY is accepted for projects still using the legacy key.
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!API_KEY) {
  console.error('Falta API_KEY: configurala en las variables de entorno.');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SECRET_KEY: configurá las variables de entorno.');
  process.exit(1);
}

// --- Persistencia en Supabase (PostgreSQL) ---
// La tabla public.brands debe tener: id, plan, transcript, profile, calendar, updated_at.
async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      // Las claves nuevas sb_secret_ se envían como apikey, no como JWT.
      // La clave legacy service_role sí es un JWT y también requiere Bearer.
      ...(!SUPABASE_KEY.startsWith('sb_secret_') ? { 'Authorization': `Bearer ${SUPABASE_KEY}` } : {}),
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; }
  catch { data = raw; }

  if (!response.ok) {
    const detail = data?.message || data?.error || raw || response.statusText;
    throw new Error(`Supabase respondió HTTP ${response.status}: ${detail}`);
  }
  return data;
}

async function getBrand(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 128) {
    throw new Error('Falta un brandId válido.');
  }

  const filter = `brands?id=eq.${encodeURIComponent(id)}&select=id,plan,transcript,profile,calendar`;
  const rows = await supabaseRequest(filter, {
    method: 'GET',
    headers: { 'Accept': 'application/json' }
  });

  if (rows?.length) return rows[0];

  const initialBrand = {
    id,
    plan: 'trial',
    transcript: [],
    profile: null,
    calendar: null
  };

  try {
    const created = await supabaseRequest('brands', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(initialBrand)
    });
    if (created?.length) return created[0];
  } catch (error) {
    // Si dos solicitudes iniciales llegan juntas, una puede crear el registro
    // y la otra recibir conflicto por la clave primaria. En ese caso releemos.
    const existing = await supabaseRequest(filter, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    if (existing?.length) return existing[0];
    throw error;
  }

  throw new Error('Supabase no devolvió el registro de la marca después de crearlo.');
}

async function saveBrand(id, patch) {
  await supabaseRequest(`brands?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
}

const ask = async (system, messages, max = 4000) => {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || 'https://sellia.vercel.app',
      'X-Title': 'Sellia MVP'
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        ...messages
      ],
      max_tokens: max,
      temperature: 0.7
    }),
    signal: AbortSignal.timeout(90000)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data?.error?.message || data?.message || JSON.stringify(data);
    throw new Error(`OpenRouter respondió HTTP ${response.status}: ${detail}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    const choice = data?.choices?.[0];
    const reason = choice?.finish_reason || 'desconocido';
    const used = data?.usage?.completion_tokens ?? 'desconocido';
    throw new Error(`OpenRouter no devolvió texto visible (finish_reason=${reason}, completion_tokens=${used}). Probá nuevamente o revisá el límite de salida del modelo.`);
  }

  return content.trim();
};

const parseJSON = (t) => {
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('La IA no devolvió un JSON válido. Probá nuevamente.');
  return JSON.parse(t.slice(start, end + 1));
};

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req.body)); }
  catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Error interno del servidor.' });
  }
};

// --- Método Sellia (núcleo del producto: ajustar acá los prompts) ---
const METHOD = `Método Sellia. Tres pilares: 1) claridad total de marca (qué problema resuelve, para quién y por qué esa marca), 2) ganchos virales (los primeros 3 segundos), 3) embudo (atraer, nutrir, convertir).
Estructura de cada pieza: gancho, problema, solución, llamado a la acción.
Tipos de gancho: contra_la_corriente, error_a_evitar, lista, resultado_primero, llamado_a_la_identidad, bucle_abierto. Adaptalos a la industria.
Historias: fases humanizar, nutrir, convertir. Español neutro latinoamericano, tono cercano.`;

const ONBOARD = `Sos Sellia, una camaleona amiga y experta en ventas que cambia de color según cada marca. Cercana, divertida, sin ser infantil. Hacés el onboarding de una marca conversando: UNA pregunta corta por mensaje. Tenés que averiguar absolutamente todo: qué vende, qué ofrece y qué NO ofrece, precios, a quién le vende, dolores y necesidades de esos clientes, por qué la eligen, diferenciales, objeciones, tono, objetivo (ventas, leads, autoridad), canales y qué contenido hizo antes. Profundizá con preguntas extra si una respuesta es vaga. Si el usuario pasa un link o texto de su web/Instagram, usalo. Cuando tengas suficiente (unas 12 a 15 respuestas), cerrá con un mensaje breve de celebración y agregá al final exactamente [[LISTO]].`;

app.post('/api/onboarding', wrap(async ({ brandId, text }) => {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Escribí un mensaje para continuar.');
  const b = await getBrand(brandId);
  const transcript = [...(b.transcript || []), { role: 'user', content: text }];
  let reply = await ask(ONBOARD, transcript, 1800);
  const done = reply.includes('[[LISTO]]');
  reply = reply.replace('[[LISTO]]', '').trim();
  transcript.push({ role: 'assistant', content: reply });
  await saveBrand(brandId, { transcript });
  return { reply, done };
}));

app.post('/api/profile', wrap(async ({ brandId }) => {
  const b = await getBrand(brandId);
  if (!b.transcript?.length) throw new Error('Todavía no hay una conversación de onboarding para esta marca.');
  const conv = b.transcript.map((m) => `${m.role}: ${m.content}`).join('\n');
  const out = await ask(`${METHOD}\nCon esta conversación de onboarding, armá el perfil de marca. Respondé SOLO JSON: {"marca":"","industria":"","problema":"","para_quien":"","por_que_esta_marca":"","ofrece":[],"no_ofrece":[],"tono":"","objetivo":"","cliente_ideal":{"nombre":"","descripcion":"","dolores":[],"deseos":[],"objeciones":[],"donde_esta":[]}}`, [{ role: 'user', content: conv }], 3000);
  const profile = parseJSON(out);
  await saveBrand(brandId, { profile });
  return profile;
}));

app.post('/api/calendar', wrap(async ({ brandId, days = 7 }) => {
  const b = await getBrand(brandId);
  if (!b.profile) throw new Error('Primero tenés que generar el perfil de marca.');
  const safeDays = Math.max(1, Math.min(30, Number(days) || 7));
  const out = await ask(`${METHOD}\nCreá DOS calendarios de ${safeDays} días para esta marca, distintos entre sí. Elegí la mezcla de formatos (reel, carrusel, video_camara, post, tour) según la industria. Cada pieza de contenido lleva su fase (atraer|nutrir|convertir) y tipo de gancho; cada historia su fase (humanizar|nutrir|convertir). Respondé SOLO JSON: {"contenido":[{"dia":1,"formato":"","fase":"","tipo_gancho":"","tema":"","gancho":""}],"historias":[{"dia":1,"fase":"","idea":""}]}`, [{ role: 'user', content: JSON.stringify(b.profile) }], 5000);
  const calendar = parseJSON(out);
  await saveBrand(brandId, { calendar });
  return calendar;
}));

app.post('/api/copy', wrap(async ({ brandId, piece }) => {
  const b = await getBrand(brandId);
  if (!b.profile) throw new Error('Primero tenés que generar el perfil de marca.');
  const out = await ask(`${METHOD}\nEscribí la pieza completa. Si el formato es carrusel, incluí "slides" (6 a 8, texto corto por slide). Si es reel o video_camara, incluí "guion" para teleprompter con tiempos. Respondé SOLO JSON: {"gancho":"","problema":"","solucion":"","cta":"","copy":"","hashtags":[],"slides":[],"guion":""}`, [{ role: 'user', content: JSON.stringify({ marca: b.profile, pieza: piece }) }], 3000);
  return { ...parseJSON(out), trial: b.plan === 'trial' };
}));

// Endpoint simple para comprobar que el backend y las variables esenciales arrancaron.
app.get('/api/brand', async (req, res) => {
  try {
    const b = await getBrand(String(req.query.id || ''));
    res.json({ transcript: b.transcript || [], profile: b.profile, calendar: b.calendar, plan: b.plan });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, storage: 'supabase', model: MODEL }));

app.listen(process.env.PORT || 3000, () => console.log('Sellia MVP en puerto ' + (process.env.PORT || 3000)));
