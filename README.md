# Sellia MVP - OpenRouter + Supabase

## Requisitos
- Node.js 20.6 o superior.
- Un proyecto Supabase con la tabla `public.brands` creada.
- Una API Key de OpenRouter.

## Variables de entorno
Copiá `.env.example` a `.env` y completá:

- `BASE_URL=https://openrouter.ai/api/v1`
- `API_KEY=...` (OpenRouter)
- `MODEL=nvidia/nemotron-3.5-lightning:free`
- `PORT=3000` (local; Vercel administra el puerto)
- `SUPABASE_URL=https://...supabase.co`
- `SUPABASE_SECRET_KEY=sb_secret_...` (solo backend)

Para proyectos que todavía usan la clave legacy, también se acepta `SUPABASE_SERVICE_ROLE_KEY`. La clave secreta nunca debe incluirse en el frontend ni subirse a GitHub.

## SQL de Supabase
Ejecutá una vez en Supabase > SQL Editor:

```sql
create table if not exists public.brands (
  id text primary key,
  plan text default 'trial',
  transcript jsonb not null default '[]'::jsonb,
  profile jsonb,
  calendar jsonb,
  updated_at timestamptz not null default now()
);

alter table public.brands enable row level security;
```

El backend utiliza la clave secreta de Supabase, que tiene acceso privilegiado y evita exponer credenciales en el navegador.

## Ejecutar localmente
```bash
npm install
npm start
```
Abrí http://localhost:3000. Para comprobar el backend: http://localhost:3000/api/health.

## Deploy en Vercel
En Settings > Environment Variables configurá `BASE_URL`, `API_KEY`, `MODEL`, `SUPABASE_URL` y `SUPABASE_SECRET_KEY` para Production (y Preview si corresponde). Después hacé Redeploy.

Los endpoints `/api/onboarding`, `/api/profile`, `/api/calendar` y `/api/copy` conservan sus rutas y contratos. El estado de cada marca se guarda en Supabase, no en un archivo local.
