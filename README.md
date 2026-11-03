# Sellia MVP - OpenRouter

## Configuracion
1. Instalar Node.js 20.6 o superior.
2. En esta carpeta, crear `.env` copiando `.env.example`.
3. Reemplazar `API_KEY` por una clave nueva de OpenRouter (https://openrouter.ai/keys).
4. No compartir ni subir `.env` a Git.

Variables:
- `BASE_URL=https://openrouter.ai/api/v1`
- `API_KEY=...`
- `MODEL=nvidia/nemotron-3.5-lightning:free`
- `PORT=3000`

## Ejecutar
```bash
npm install
npm start
```
Abrir http://localhost:3000.

El backend usa `POST /chat/completions` de OpenRouter desde el servidor. La clave no se expone al navegador. Los endpoints de Sellia (`/api/onboarding`, `/api/profile`, `/api/calendar`, `/api/copy`) mantienen su formato original.

Requisito: Node.js 20.6+ (usa `--env-file` y `fetch` nativos).
