# JARVIS AI

Personal JARVIS-style AI assistant built as an iPhone-friendly PWA with a FastAPI backend and Gemini.

## Current architecture

- iPhone browser/PWA frontend
- FastAPI backend
- Gemini model integration
- Bearer-token authentication
- Conversation history on the client
- Server-side session context during a running backend session
- Browser speech-to-text when supported
- Browser text-to-speech
- Health and status endpoints
- Fast local time, date, and calculator responses
- Service-worker cache updates

## Environment variables

Set these on the backend host. Never commit them.

- GEMINI_API_KEY
- GEMINI_MODEL
- JARVIS_AUTH_TOKEN

## Manual setup still required

1. Keep the Gemini API key only in the backend environment.
2. Keep the JARVIS authentication token private.
3. In the deployed PWA, configure the backend URL and authentication token.
4. Add/install the PWA on the iPhone if desired.
5. Grant microphone permission if using browser voice input.

## Next engineering stages

The foundation is ready for real tool calling. The next major modules are web search, durable database memory, calendar/reminders, email and messaging integrations, document/file analysis, confirmation workflows, scheduled automation, and optional desktop control.

iOS browser security limits unrestricted control of other apps and system functions. Those capabilities require approved APIs, Shortcuts/App Intents, or an optional desktop companion.
