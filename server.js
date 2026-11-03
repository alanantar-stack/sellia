import express from 'express';
import fs from 'fs';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));
const BASE_URL = (process.env.BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const API_KEY = process.env.API_KEY;
const MODEL = process.env.MODEL || 'nvidia/nemotron-3.5-lightning:free';

if (!API_KEY) {
  console.error('Falta API_KEY en el archivo .env');
  process.exit(1);
}



// --- Persistencia mínima (JSON). Reemplazar por Postgres/SQLite al pasar de prototipo. ---
const DB = 'data.json';
const load = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : { brands: {} });
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 1));
const getBrand = (id) => {
  const db = load();
  const b = db.brands[id] ||= { id, plan: 'trial', transcript: [], profile: null, calendar: null };
  return { db, b };
};

const ask = async (system, messages, max = 4000) => {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'Sellia MVP'
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        ...messages
      ],
      // Nemotron es un modelo con razonamiento; desactivarlo evita
      // que consuma todo el presupuesto antes de producir texto visible.
      reasoning: { enabled: false },
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
const parseJSON = (t) => JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req.body)); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
};

// --- Método Sellia (núcleo del producto: ajustar acá los prompts) ---
const METHOD = `Método Sellia. Tres pilares: 1) claridad total de marca (qué problema resuelve, para quién y por qué esa marca), 2) ganchos virales (los primeros 3 segundos), 3) embudo (atraer, nutrir, convertir).
Estructura de cada pieza: gancho, problema, solución, llamado a la acción.
Tipos de gancho: contra_la_corriente, error_a_evitar, lista, resultado_primero, llamado_a_la_identidad, bucle_abierto. Adaptalos a la industria.
Historias: fases humanizar, nutrir, convertir. Español neutro latinoamericano, tono cercano.`;

const ONBOARD = `Sos Sellia, una camaleona amiga y experta en ventas que cambia de color según cada marca. Cercana, divertida, sin ser infantil. Hacés el onboarding de una marca conversando: UNA pregunta corta por mensaje. Tenés que averiguar absolutamente todo: qué vende, qué ofrece y qué NO ofrece, precios, a quién le vende, dolores y necesidades de esos clientes, por qué la eligen, diferenciales, objeciones, tono, objetivo (ventas, leads, autoridad), canales y qué contenido hizo antes. Profundizá con preguntas extra si una respuesta es vaga. Si el usuario pasa un link o texto de su web/Instagram, usalo. Cuando tengas suficiente (unas 12 a 15 respuestas), cerrá con un mensaje breve de celebración y agregá al final exactamente [[LISTO]].`;

app.post('/api/onboarding', wrap(async ({ brandId, text }) => {
  const { db, b } = getBrand(brandId);
  b.transcript.push({ role: 'user', content: text });
  let reply = await ask(ONBOARD, b.transcript, 1800);
  const done = reply.includes('[[LISTO]]');
  reply = reply.replace('[[LISTO]]', '').trim();
  b.transcript.push({ role: 'assistant', content: reply });
  save(db);
  return { reply, done };
}));

app.post('/api/profile', wrap(async ({ brandId }) => {
  const { db, b } = getBrand(brandId);
  const conv = b.transcript.map((m) => `${m.role}: ${m.content}`).join('\n');
  const out = await ask(`${METHOD}\nCon esta conversación de onboarding, armá el perfil de marca. Respondé SOLO JSON: {"marca":"","industria":"","problema":"","para_quien":"","por_que_esta_marca":"","ofrece":[],"no_ofrece":[],"tono":"","objetivo":"","cliente_ideal":{"nombre":"","descripcion":"","dolores":[],"deseos":[],"objeciones":[],"donde_esta":[]}}`, [{ role: 'user', content: conv }], 3000);
  b.profile = parseJSON(out);
  save(db);
  return b.profile;
}));

app.post('/api/calendar', wrap(async ({ brandId, days = 7 }) => {
  const { db, b } = getBrand(brandId);
  const out = await ask(`${METHOD}\nCreá DOS calendarios de ${days} días para esta marca, distintos entre sí. Elegí la mezcla de formatos (reel, carrusel, video_camara, post, tour) según la industria. Cada pieza de contenido lleva su fase (atraer|nutrir|convertir) y tipo de gancho; cada historia su fase (humanizar|nutrir|convertir). Respondé SOLO JSON: {"contenido":[{"dia":1,"formato":"","fase":"","tipo_gancho":"","tema":"","gancho":""}],"historias":[{"dia":1,"fase":"","idea":""}]}`, [{ role: 'user', content: JSON.stringify(b.profile) }], 5000);
  b.calendar = parseJSON(out);
  save(db);
  return b.calendar;
}));

app.post('/api/copy', wrap(async ({ brandId, piece }) => {
  const { b } = getBrand(brandId);
  const out = await ask(`${METHOD}\nEscribí la pieza completa. Si el formato es carrusel, incluí "slides" (6 a 8, texto corto por slide). Si es reel o video_camara, incluí "guion" para teleprompter con tiempos. Respondé SOLO JSON: {"gancho":"","problema":"","solucion":"","cta":"","copy":"","hashtags":[],"slides":[],"guion":""}`, [{ role: 'user', content: JSON.stringify({ marca: b.profile, pieza: piece }) }], 3000);
  return { ...parseJSON(out), trial: b.plan === 'trial' };
}));

app.listen(process.env.PORT || 3000, () => console.log('Sellia MVP en http://localhost:' + (process.env.PORT || 3000)));
