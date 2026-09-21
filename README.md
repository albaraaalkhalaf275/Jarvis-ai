# JARVIS

A clean, Render-ready personal AI assistant.

## Architecture

- Frontend: static mobile-first web/PWA in `web/`
- Backend: FastAPI in `backend/`
- AI: OpenAI Responses API
- Deployment: Render
- Secrets: environment variables only

## Local development

Backend:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r ../requirements.txt
export OPENAI_API_KEY="your-key"
uvicorn app.main:app --reload
```

Frontend can be served as static files from `web/`.

## Required environment variables

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default: `gpt-5.6`)
- `ALLOW_GUEST` (default: `true`)
- `FRONTEND_ORIGINS` (comma-separated allowed frontend origins)

Never commit API keys or service-role credentials.
