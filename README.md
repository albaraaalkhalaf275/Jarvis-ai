# JARVIS

Custom-built personal AI assistant with a mobile-first HUD interface and FastAPI backend.

## UI contract

No decorative action buttons are left unhandled.

Chat controls:
- navigation buttons switch views
- status runs a live health check
- new chat resets the local conversation
- attach selects files and sends them through the file-analysis path when a message is submitted
- send submits the current request

Tool Center:
- Web Search uses the OpenAI Responses API web-search tool
- Calculator uses the backend safe calculator
- Calendar opens the local task scheduler
- Summarize and Translate send focused requests to JARVIS
- Analyze opens the file analysis workflow

Memory, Tasks, Files, and Settings each have working local controls.

## Backend

FastAPI uses the OpenAI Responses API. The assistant supports function calling, optional live web search, and uploaded file inputs.

The OpenAI Responses API supports built-in tools including web search and file inputs. GPT-5.6 supports function calling, web search, file search, and computer use.

## Environment

Required:
- `OPENAI_API_KEY`

Optional:
- `OPENAI_MODEL` defaults to `gpt-5.6`
- `ALLOW_GUEST` defaults to `true`
- `FRONTEND_ORIGINS`
- `ALLOWED_HOSTS`

Never commit secrets.

## Deployment

Render builds the backend from the `backend` directory:

```
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port $PORT
```
