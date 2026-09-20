# JARVIS AI

Personal JARVIS-style AI assistant built as an iPhone-friendly PWA with a FastAPI backend and the OpenAI Responses API.

## Current architecture

- iPhone browser/PWA frontend
- FastAPI backend
- OpenAI Responses API
- Server-side API credentials
- Supabase authentication support
- Conversation history stored locally in the browser
- Server-side session context during a running backend session
- Health and status endpoints
- Service-worker cache updates
- Text-first interface while voice features are paused

## Repository structure

- `backend/app/main.py` - backend application and API routes
- `backend/app/__init__.py` - Python package marker
- `backend/requirements.txt` - backend dependencies
- `web/index.html` - PWA interface
- `web/styles.css` - JARVIS HUD styling
- `web/app.js` - frontend application logic
- `web/sw.js` - service worker and cache management
- `web/manifest.webmanifest` - PWA metadata
- `.github/workflows/validate.yml` - Python and JavaScript validation
- `.gitignore` - repository exclusions
- `README.md` - project documentation

## Environment variables

Secrets belong only on the backend host and must never be committed.

Core:
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

Authentication and access:
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `OWNER_EMAIL`
- `OWNER_USER_ID`
- `ALLOW_GUEST`

Optional integrations:
- `FISH_AUDIO_API_KEY`
- `FISH_AUDIO_VOICE_ID`
- `FISH_AUDIO_MODEL`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `JARVIS_OWNER_PHONE`

## Deployment

Render uses the same GitHub repository with two services:

- Frontend: static site rooted at `web`
- Backend: Python web service rooted at `backend`

Both services deploy from the `main` branch.

## Engineering direction

The foundation will be extended with web search, durable memory, tool calling, calendar and reminders, email and messaging integrations, document and file analysis, confirmation workflows, scheduled automation, computer control through an optional desktop companion, and self-verification.

iOS browser security limits unrestricted control of other apps and system functions. Those capabilities require approved APIs, Shortcuts/App Intents, or an optional desktop companion.
