import ast
import html
import math
import operator
import os
import re
import time
from datetime import datetime
from typing import Optional

import httpx
import jwt
from jwt import PyJWKClient
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field
from google import genai
from twilio.rest import Client as TwilioClient
from twilio.request_validator import RequestValidator
from twilio.twiml.voice_response import VoiceResponse

load_dotenv()

app = FastAPI(title="JARVIS Gemini Backend", docs_url=None, redoc_url=None)

API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash").strip()
AUTH_TOKEN = os.getenv("JARVIS_AUTH_TOKEN", "").strip()

FISH_AUDIO_API_KEY = os.getenv("FISH_AUDIO_API_KEY", "").strip()
FISH_AUDIO_VOICE_ID = os.getenv(
    "FISH_AUDIO_VOICE_ID",
    "612b878b113047d9a770c069c8b4fdfe",
).strip()
FISH_AUDIO_MODEL = os.getenv("FISH_AUDIO_MODEL", "s2.1-pro").strip()
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
TWILIO_PHONE_NUMBER = os.getenv("TWILIO_PHONE_NUMBER", "").strip()
JARVIS_OWNER_PHONE = os.getenv("JARVIS_OWNER_PHONE", "").strip()
OWNER_EMAIL = os.getenv("JARVIS_OWNER_EMAIL", "").strip().lower()
OWNER_USER_ID = os.getenv("JARVIS_OWNER_USER_ID", "").strip()
OWNER_GITHUB_LOGIN = os.getenv("JARVIS_OWNER_GITHUB_LOGIN", "").strip().lower()
ALLOW_GUEST = os.getenv("ALLOW_GUEST", "true").strip().lower() in {"1", "true", "yes"}
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "").strip()
SUPABASE_JWKS_URL = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else ""
SUPABASE_ISSUER = f"{SUPABASE_URL}/auth/v1" if SUPABASE_URL else ""
SUPABASE_JWKS = PyJWKClient(SUPABASE_JWKS_URL) if SUPABASE_JWKS_URL else None
GUEST_RATE_LIMIT = int(os.getenv("GUEST_RATE_LIMIT", "20"))
GUEST_RATE_WINDOW = 60
GUEST_HITS: dict[str, list[float]] = {}
REQUEST_HITS: dict[str, list[float]] = {}
RATE_LIMIT = int(os.getenv("RATE_LIMIT", "60"))
RATE_WINDOW = 60
MAX_BODY_BYTES = int(os.getenv("MAX_BODY_BYTES", "262144"))
FRONTEND_ORIGINS = [
    origin.strip().rstrip("/")
    for origin in os.getenv(
        "FRONTEND_ORIGINS",
        "https://jarvis-ai-1-12xu.onrender.com,http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]
ALLOWED_HOSTS = [
    host.strip()
    for host in os.getenv(
        "ALLOWED_HOSTS",
        "jarvis-ai-uhe3.onrender.com,localhost,127.0.0.1",
    ).split(",")
    if host.strip()
]

class SecurityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method in {"POST", "PUT", "PATCH"}:
            content_length = request.headers.get("content-length")
            if content_length:
                try:
                    if int(content_length) > MAX_BODY_BYTES:
                        return Response("Request too large", status_code=413)
                except ValueError:
                    return Response("Invalid Content-Length", status_code=400)

        if request.url.path.startswith("/api/"):
            ip = request.client.host if request.client else "unknown"
            key = f"{ip}:{request.url.path}"
            now = time.time()
            hits = [t for t in REQUEST_HITS.get(key, []) if now - t < RATE_WINDOW]
            if len(hits) >= RATE_LIMIT:
                return Response(
                    "Rate limit exceeded. Please slow down.",
                    status_code=429,
                    headers={"Retry-After": "60", "Cache-Control": "no-store"},
                )
            hits.append(now)
            REQUEST_HITS[key] = hits

        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), geolocation=(), payment=(), usb=()"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-XSS-Protection"] = "0"
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
        return response

app.add_middleware(SecurityMiddleware)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=ALLOWED_HOSTS,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

SYSTEM = """
You are JARVIS, a personal AI assistant with two operating modes.

CORE PERSONALITY
Be intelligent, concise, practical, honest, and confident.
Use conversation history for context.
Never claim an action was completed unless a connected tool actually performed it.
If a capability is unavailable, say so clearly.
Do not invent current information.
Protect the user's control. Require confirmation before dangerous, destructive, financial, account, or external communication actions.

FUN MODE
JARVIS is also the user's companion when the conversation is casual.
When the user is joking, relaxing, teasing, celebrating, or explicitly asks for fun, be playful.
Make jokes, light sarcasm, witty observations, playful banter, and occasional dry humor.
Match the user's energy without becoming obnoxious.
You may tease the user lightly, but never be cruel, humiliating, or hostile.
Do not turn every casual message into a lecture or formal assistant response.
Keep jokes concise unless the user clearly wants a longer comedic exchange.
If the user says things like "fun mode", "time for fun", "let's mess around", or similar, explicitly enter a playful conversational mode.
In Fun Mode, you can stay playful across several messages until the user signals a return to serious work.

DUTY MODE
For work, school, technical tasks, planning, security, money, accounts, important decisions, emergencies, or explicit serious requests, switch to focused duty behavior.
Be precise, calm, structured, and task-oriented.
Do not add jokes when they would reduce clarity or undermine the seriousness of the task.
If the user says "serious mode", "duty mode", "back to work", or similar, return to focused duty behavior.

MODE SAFETY
Fun Mode changes personality and tone, not safety rules.
Never perform a dangerous, destructive, financial, account, or communication action merely because the conversation is playful.
When seriousness and humor conflict, prioritize safety and clarity.
"""

SESSIONS: dict[str, list[dict]] = {}
MAX_SESSION_MESSAGES = 40


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=12000)
    history: list[dict] = Field(default_factory=list)
    session_id: Optional[str] = Field(default=None, max_length=128)


class ChatResponse(BaseModel):
    reply: str
    model: str
    session_id: Optional[str] = None


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


def authenticate_request(authorization: Optional[str], request: Optional[Request] = None):
    if not authorization:
        if ALLOW_GUEST:
            if request:
                ip = request.client.host if request.client else "unknown"
                now = time.time()
                hits = [t for t in GUEST_HITS.get(ip, []) if now - t < GUEST_RATE_WINDOW]
                if len(hits) >= GUEST_RATE_LIMIT:
                    raise HTTPException(status_code=429, detail="Guest rate limit reached. Please wait a minute or sign in.")
                hits.append(now)
                GUEST_HITS[ip] = hits
            return {"guest": True, "owner": False}
        raise HTTPException(status_code=401, detail="Authentication required")

    if AUTH_TOKEN and authorization == f"Bearer {AUTH_TOKEN}":
        return {"guest": False, "legacy": True, "owner": True}

    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid JARVIS authentication token")

    token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Invalid JARVIS authentication token")

    # Prefer Supabase's Auth user endpoint for browser access tokens.
    # The endpoint validates the access token server-side and returns the canonical user.
    if SUPABASE_URL:
        try:
            result = httpx.get(
                f"{SUPABASE_URL}/auth/v1/user",
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": SUPABASE_PUBLISHABLE_KEY or token,
                },
                timeout=8,
            )
            if result.status_code == 200:
                user = result.json()
                user_id = str(user.get("id") or "")
                email = str(user.get("email") or "").lower()
                owner = bool(
                    (OWNER_USER_ID and user_id == OWNER_USER_ID)
                    or (OWNER_EMAIL and email == OWNER_EMAIL)
                )
                return {
                    "guest": False,
                    "user_id": user_id,
                    "email": email,
                    "owner": owner,
                }
        except httpx.HTTPError:
            pass

    # Fallback to local JWT verification when the Auth endpoint is unavailable.
    if SUPABASE_JWKS:
        try:
            header = jwt.get_unverified_header(token)
            alg = header.get("alg")
            if alg not in {"ES256", "RS256"}:
                raise ValueError("Unsupported JWT algorithm")
            signing_key = SUPABASE_JWKS.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=[alg],
                audience="authenticated",
                issuer=SUPABASE_ISSUER,
            )
            user_id = str(claims.get("sub") or "")
            email = str(claims.get("email") or "").lower()
            owner = bool(
                (OWNER_USER_ID and user_id == OWNER_USER_ID)
                or (OWNER_EMAIL and email == OWNER_EMAIL)
            )
            return {
                "guest": False,
                "user_id": user_id,
                "email": email,
                "owner": owner,
            }
        except Exception:
            pass

    raise HTTPException(status_code=401, detail="Invalid JARVIS authentication token")

def check_auth(authorization: Optional[str], request: Optional[Request] = None):
    return authenticate_request(authorization, request)


def require_owner(authorization: Optional[str], request: Optional[Request] = None):
    user = authenticate_request(authorization, request)
    if not user.get("owner"):
        raise HTTPException(status_code=403, detail="Owner access required")
    return user


def get_authenticated_user(authorization: Optional[str], request: Optional[Request] = None):
    return authenticate_request(authorization, request)


def is_authenticated_owner(authorization: Optional[str], request: Optional[Request] = None):
    return authenticate_request(authorization, request).get("owner", False)


def is_authenticated(authorization: Optional[str], request: Optional[Request] = None):
    return authenticate_request(authorization, request)


def get_session_history(req: ChatRequest) -> list[dict]:
    if req.session_id and req.session_id in SESSIONS:
        return SESSIONS[req.session_id][-MAX_SESSION_MESSAGES:]
    return req.history[-20:]


def save_session(session_id: Optional[str], history: list[dict]):
    if session_id:
        SESSIONS[session_id] = history[-MAX_SESSION_MESSAGES:]


_ALLOWED_BINOPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
    ast.Mod: operator.mod,
}
_ALLOWED_UNARY = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}


def safe_calculate(expression: str) -> Optional[str]:
    expression = expression.strip().replace("×", "*").replace("÷", "/")
    if len(expression) > 200 or not re.fullmatch(r"[0-9+*/().%\s\-]+", expression):
        return None

    try:
        tree = ast.parse(expression, mode="eval")

        def evaluate(node):
            if isinstance(node, ast.Expression):
                return evaluate(node.body)
            if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
                if not math.isfinite(node.value):
                    raise ValueError
                return node.value
            if isinstance(node, ast.BinOp) and type(node.op) in _ALLOWED_BINOPS:
                left, right = evaluate(node.left), evaluate(node.right)
                if isinstance(node.op, ast.Pow) and abs(right) > 100:
                    raise ValueError
                value = _ALLOWED_BINOPS[type(node.op)](left, right)
                if not math.isfinite(value) or abs(value) > 1e100:
                    raise ValueError
                return value
            if isinstance(node, ast.UnaryOp) and type(node.op) in _ALLOWED_UNARY:
                return _ALLOWED_UNARY[type(node.op)](evaluate(node.operand))
            raise ValueError

        value = evaluate(tree)
        return str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)
    except Exception:
        return None


def local_fast_path(message: str) -> Optional[str]:
    text = message.strip().lower()

    if re.fullmatch(r"(what('s| is) )?(the )?time( right now)?\??", text):
        return datetime.now().astimezone().strftime("It is %I:%M %p.")

    if re.fullmatch(r"(what('s| is) )?(today('s)? )?date\??", text):
        return datetime.now().astimezone().strftime("Today is %A, %B %d, %Y.")

    if re.fullmatch(r"(hi|hello|hey)( jarvis)?[!. ]*", text):
        return "Hello. JARVIS is online and ready."

    if text in {"thanks", "thank you", "thx"}:
        return "You are welcome."

    if text in {"who are you", "what are you", "what is jarvis"}:
        return "I am JARVIS, your personal AI assistant."

    if text in {"what can you do", "what can you do?", "capabilities"}:
        return "I can chat, keep conversation context, use connected tools, handle voice, and run supported assistant workflows."

    if re.fullmatch(r"(calculate|compute)\s+.+", text):
        expression = re.sub(r"^(calculate|compute)\s+", "", message.strip(), flags=re.I)
        result = safe_calculate(expression)
        if result is not None:
            return result

    return None


def prepare_jarvis_speech(text: str) -> str:
    """Prepare concise, controlled delivery for the JARVIS voice."""
    text = re.sub(r"\\s+", " ", text).strip()
    if not text:
        return text

    # Keep spoken output clean. Avoid reading markdown formatting aloud.
    text = re.sub(r"```[\\s\\S]*?```", "", text)
    text = re.sub(r"[*_`#]+", "", text)
    text = re.sub(r"\\[([^\\]]+)\\]\\([^\\)]+\\)", r"\\1", text)
    text = re.sub(r"\\s{2,}", " ", text).strip()

    # Give short confirmations and status responses a deliberate opening.
    if len(text) <= 140 and not text.startswith("["):
        return f"[emphasis]{text}"

    return text


async def fish_tts(text: str) -> bytes:
    if not FISH_AUDIO_API_KEY:
        raise HTTPException(status_code=503, detail="Fish Audio is not configured")

    headers = {
        "Authorization": f"Bearer {FISH_AUDIO_API_KEY}",
        "Content-Type": "application/json",
        "model": FISH_AUDIO_MODEL,
    }
    payload = {
        "text": prepare_jarvis_speech(text),
        "reference_id": FISH_AUDIO_VOICE_ID,
        "format": "mp3",
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            result = await client.post(
                "https://api.fish.audio/v1/tts",
                headers=headers,
                json=payload,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Fish Audio connection failed: {exc}")

    if result.status_code != 200:
        detail = result.text[:500] or "Fish Audio synthesis failed"
        raise HTTPException(status_code=502, detail=detail)

    return result.content


@app.post("/api/voice/twiml")
async def voice_twiml(request: Request):
    if not TWILIO_AUTH_TOKEN:
        raise HTTPException(status_code=503, detail="Twilio voice is not configured")
    form = await request.form()
    signature = request.headers.get("X-Twilio-Signature", "")
    validator = RequestValidator(TWILIO_AUTH_TOKEN)
    if not validator.validate(str(request.url), dict(form), signature):
        raise HTTPException(status_code=403, detail="Invalid Twilio signature")
    response = VoiceResponse()
    connect = response.connect()
    connect.conversation_relay(
        url=f"wss://{request.url.hostname}/api/voice/ws",
        welcome_greeting="JARVIS is online. How can I assist you?"
    )
    return Response(content=str(response), media_type="application/xml")


@app.post("/api/voice/call")
async def voice_call(request: Request, authorization: Optional[str] = Header(default=None)):
    require_owner(authorization, request)
    if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN or not TWILIO_PHONE_NUMBER or not JARVIS_OWNER_PHONE:
        raise HTTPException(status_code=503, detail="Twilio voice is not configured")
    client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    try:
        call = client.calls.create(
            to=JARVIS_OWNER_PHONE,
            from_=TWILIO_PHONE_NUMBER,
            url=f"https://{request.url.hostname}/api/voice/twiml",
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Twilio call failed: {exc}")
    return {"ok": True, "call_sid": call.sid, "status": call.status}


@app.websocket("/api/voice/ws")
async def voice_ws(websocket: WebSocket):
    if not TWILIO_AUTH_TOKEN:
        await websocket.close(code=1008, reason="Twilio voice is not configured")
        return
    signature = websocket.headers.get("x-twilio-signature", "")
    validator = RequestValidator(TWILIO_AUTH_TOKEN)
    if not validator.validate(str(websocket.url), dict(websocket.query_params), signature):
        await websocket.close(code=1008, reason="Invalid Twilio signature")
        return
    await websocket.accept()
    if not API_KEY:
        await websocket.close(code=1011, reason="Gemini is not configured")
        return
    client = genai.Client(api_key=API_KEY)
    history = []
    try:
        while True:
            message = await websocket.receive_json()
            if message.get("type") != "prompt":
                continue
            user_text = str(message.get("voicePrompt", "")).strip()
            if not user_text:
                continue
            history.append({"role": "user", "text": user_text})
            contents = []
            for item in history[-20:]:
                role = "model" if item["role"] == "assistant" else "user"
                contents.append({"role": role, "parts": [{"text": item["text"]}]})
            result = client.models.generate_content(
                model=MODEL,
                contents=contents,
                config={
                    "system_instruction": SYSTEM,
                    "temperature": 0.35,
                    "max_output_tokens": 400,
                    "thinking_config": {"thinking_level": "minimal"},
                },
            )
            reply = (result.text or "I am here.").strip()
            history.append({"role": "assistant", "text": reply})
            await websocket.send_json({"type": "text", "token": reply, "last": True})
    except WebSocketDisconnect:
        return
    except Exception:
        try:
            await websocket.close(code=1011, reason="JARVIS voice session failed")
        except Exception:
            pass

@app.get("/api/me")
def current_user(authorization: Optional[str] = Header(default=None), request: Request = None):
    user = authenticate_request(authorization, request)
    return {
        "authenticated": not user.get("guest", False),
        "owner": bool(user.get("owner", False)),
        "user_id": user.get("user_id"),
    }


@app.get("/api/config")
def public_config():
    return {
        "supabase_url": SUPABASE_URL,
        "supabase_publishable_key": SUPABASE_PUBLISHABLE_KEY,
    }


@app.get("/health")
def health():
    return {
        "ok": True,
        "gemini_configured": bool(API_KEY),
        "tts_configured": bool(FISH_AUDIO_API_KEY),
        "model": MODEL,
        "sessions": len(SESSIONS),
    }


@app.get("/api/status")
def status(authorization: Optional[str] = Header(default=None)):
    check_auth(authorization)
    return {
        "ok": True,
        "service": "JARVIS",
        "gemini_configured": bool(API_KEY),
        "tts_configured": bool(FISH_AUDIO_API_KEY),
        "tts_voice": FISH_AUDIO_VOICE_ID,
        "model": MODEL,
        "active_sessions": len(SESSIONS),
        "capabilities": [
            "chat",
            "conversation context",
            "Fish Audio JARVIS text-to-speech",
            "voice through the web client",
            "time",
            "date",
            "calculator",
        ],
    }


@app.post("/api/speak")
async def speak(req: SpeakRequest, request: Request, authorization: Optional[str] = Header(default=None)):
    check_auth(authorization, request)
    audio = await fish_tts(req.text)
    return Response(content=audio, media_type="audio/mpeg")

    
@app.post("/api/chat/stream")
def chat_stream(req: ChatRequest, request: Request, authorization: Optional[str] = Header(default=None)):
    user = authenticate_request(authorization, request)

    if not API_KEY:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY is not configured")

    message = req.message.strip()
    fast_reply = local_fast_path(message)

    if fast_reply is not None:
        def fast_events():
            import json
            yield f"data: {json.dumps({'text': fast_reply}, ensure_ascii=False)}\\n\\n"
            yield "data: [DONE]\\n\\n"
        return StreamingResponse(fast_events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    client = genai.Client(api_key=API_KEY)
    prior_history = get_session_history(req)
    contents = []
    for item in prior_history:
        role = item.get("role", "user")
        text = str(item.get("text", "")).strip()
        if text:
            contents.append({"role": "model" if role == "assistant" else "user", "parts": [{"text": text}]})
    contents.append({"role": "user", "parts": [{"text": message}]})

    thinking_level = (
        "minimal"
        if len(message) < 120 and not re.search(r"\b(why|how|compare|analy[sz]e|debug|design|plan|calculate)\b", message, flags=re.I)
        else "low"
    )
    config = {
        "system_instruction": SYSTEM,
        "temperature": 0.2,
        "max_output_tokens": 512,
        "thinking_config": {"thinking_level": thinking_level},
    }

    def event_stream():
        import json
        parts = []
        try:
            stream = client.models.generate_content_stream(model=MODEL, contents=contents, config=config)
            for chunk in stream:
                text = getattr(chunk, "text", None) or ""
                if text:
                    parts.append(text)
                    yield f"data: {json.dumps({'text': text}, ensure_ascii=False)}\\n\\n"
            reply = "".join(parts).strip()
            if not reply:
                reply = "I received the request, but Gemini returned no text."
                yield f"data: {json.dumps({'text': reply}, ensure_ascii=False)}\\n\\n"
            if req.session_id:
                save_session(req.session_id, prior_history + [{"role": "user", "text": message}, {"role": "assistant", "text": reply}])
            yield "data: [DONE]\\n\\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': f'Gemini request failed: {exc}'}, ensure_ascii=False)}\\n\\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest, request: Request, authorization: Optional[str] = Header(default=None)):
    user = authenticate_request(authorization, request)

    if not API_KEY:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY is not configured")

    message = req.message.strip()
    fast_reply = local_fast_path(message)
    if fast_reply is not None:
        return ChatResponse(reply=fast_reply, model=MODEL, session_id=req.session_id)

    client = genai.Client(api_key=API_KEY)
    prior_history = get_session_history(req)
    contents = []

    for item in prior_history:
        role = item.get("role", "user")
        text = str(item.get("text", "")).strip()
        if text:
            contents.append({
                "role": "model" if role == "assistant" else "user",
                "parts": [{"text": text}],
            })

    contents.append({"role": "user", "parts": [{"text": message}]})

    thinking_level = (
        "minimal"
        if len(message) < 120 and not re.search(
            r"\b(why|how|compare|analy[sz]e|debug|design|plan|calculate)\b",
            message,
            flags=re.I,
        )
        else "low"
    )

    try:
        result = client.models.generate_content(
            model=MODEL,
            contents=contents,
            config={
                "system_instruction": SYSTEM,
                "temperature": 0.2,
                "max_output_tokens": 512,
                "thinking_config": {
                    "thinking_level": thinking_level,
                },
            },
        )

        reply = (result.text or "").strip()
        if not reply:
            reply = "I received the request, but Gemini returned no text."

        if req.session_id:
            updated = prior_history + [
                {"role": "user", "text": message},
                {"role": "assistant", "text": reply},
            ]
            save_session(req.session_id, updated)

        return ChatResponse(reply=reply, model=MODEL, session_id=req.session_id)

    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Gemini request failed: {exc}")
