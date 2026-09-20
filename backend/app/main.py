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
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from google import genai

load_dotenv()

app = FastAPI(title="JARVIS Gemini Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash").strip()
AUTH_TOKEN = os.getenv("JARVIS_AUTH_TOKEN", "").strip()

FISH_AUDIO_API_KEY = os.getenv("FISH_AUDIO_API_KEY", "").strip()
FISH_AUDIO_VOICE_ID = os.getenv(
    "FISH_AUDIO_VOICE_ID",
    "612b878b113047d9a770c069c8b4fdfe",
).strip()
FISH_AUDIO_MODEL = os.getenv("FISH_AUDIO_MODEL", "s2.1-pro").strip()
ALLOW_GUEST = os.getenv("ALLOW_GUEST", "true").strip().lower() in {"1", "true", "yes"}
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_JWKS_URL = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else ""
SUPABASE_ISSUER = f"{SUPABASE_URL}/auth/v1" if SUPABASE_URL else ""
SUPABASE_JWKS = PyJWKClient(SUPABASE_JWKS_URL) if SUPABASE_JWKS_URL else None
GUEST_RATE_LIMIT = int(os.getenv("GUEST_RATE_LIMIT", "20"))
GUEST_RATE_WINDOW = 60
GUEST_HITS: dict[str, list[float]] = {}

SYSTEM = """
You are JARVIS, a personal AI assistant.

Be intelligent, concise, practical, and honest.
Use the conversation history for context.
Never claim that you performed an action unless a connected tool actually performed it.
If a capability is unavailable, clearly explain that it is unavailable.
For dangerous, destructive, financial, account, or communication actions, require confirmation before execution.
Do not invent current information. If live web access is unavailable, say so.
Prefer direct answers and useful next steps.
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


def check_auth(authorization: Optional[str], request: Optional[Request] = None):
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
            return {"guest": True}
        if AUTH_TOKEN:
            raise HTTPException(status_code=401, detail="Authentication required")
        return {"guest": True}

    if AUTH_TOKEN and authorization == f"Bearer {AUTH_TOKEN}":
        return {"guest": False, "legacy": True}

    if authorization.startswith("Bearer ") and SUPABASE_JWKS:
        token = authorization[7:].strip()
        try:
            signing_key = SUPABASE_JWKS.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=[signing_key.algorithm_name],
                audience="authenticated",
                issuer=SUPABASE_ISSUER,
            )
            return {"guest": False, "user_id": claims.get("sub")}
        except Exception:
            pass

    raise HTTPException(status_code=401, detail="Invalid JARVIS authentication token")


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


async def fish_tts(text: str) -> bytes:
    if not FISH_AUDIO_API_KEY:
        raise HTTPException(status_code=503, detail="Fish Audio is not configured")

    headers = {
        "Authorization": f"Bearer {FISH_AUDIO_API_KEY}",
        "Content-Type": "application/json",
        "model": FISH_AUDIO_MODEL,
    }
    payload = {
        "text": text,
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
    check_auth(authorization, request)

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
    check_auth(authorization, request)

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
