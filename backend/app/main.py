import ast
import json
import math
import operator
import os
import re
import time
from collections import defaultdict
from datetime import datetime
from typing import Optional

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import StreamingResponse
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field

APP_NAME = "JARVIS"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.6").strip()
OPENAI_URL = "https://api.openai.com/v1/responses"
ALLOW_GUEST = os.getenv("ALLOW_GUEST", "true").lower() in {"1", "true", "yes"}
FRONTEND_ORIGINS = [x.strip() for x in os.getenv("FRONTEND_ORIGINS", "https://jarvis-ai-1-12xu.onrender.com,http://localhost:5173,http://127.0.0.1:5173").split(",") if x.strip()]
ALLOWED_HOSTS = [x.strip() for x in os.getenv("ALLOWED_HOSTS", "*.onrender.com,localhost,127.0.0.1").split(",") if x.strip()]

SYSTEM_PROMPT = """You are JARVIS, a capable personal AI assistant.

Be accurate, direct, useful, and honest about uncertainty.
Answer the user's actual request first.
Use conversation context when supplied.
Do not invent facts, actions, sources, tool results, or capabilities.
For technical work, prioritize correctness, security, reliability, and maintainability.
If something cannot be done, say so clearly and provide the closest useful alternative.
Never claim an external action happened unless a tool actually performed it.
Require confirmation before destructive, financial, privacy-sensitive, account-changing, or external communication actions.
"""

app = FastAPI(title=APP_NAME, docs_url=None, redoc_url=None)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
app.add_middleware(GZipMiddleware, minimum_size=1000)

GUEST_HITS: dict[str, list[float]] = defaultdict(list)
GUEST_RATE_LIMIT = 60
GUEST_RATE_WINDOW = 60
SESSIONS: dict[str, list[dict]] = {}
MAX_SESSION_MESSAGES = 40


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=12000)
    history: list[dict] = Field(default_factory=list, max_length=40)
    session_id: Optional[str] = Field(default=None, max_length=128)


class ChatResponse(BaseModel):
    reply: str
    model: str
    session_id: Optional[str] = None


def authenticate(request: Request, authorization: Optional[str]) -> None:
    if authorization:
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "Invalid authorization header")
        token = authorization[7:].strip()
        if not token:
            raise HTTPException(401, "Invalid authorization token")
        # Authentication providers will be added in a later phase.
        # For now, any explicitly supplied bearer token is rejected rather than trusted.
        raise HTTPException(401, "Authentication is not configured in this foundation build")

    if not ALLOW_GUEST:
        raise HTTPException(401, "Authentication required")

    ip = request.client.host if request.client else "unknown"
    now = time.time()
    recent = [t for t in GUEST_HITS[ip] if now - t < GUEST_RATE_WINDOW]
    if len(recent) >= GUEST_RATE_LIMIT:
        raise HTTPException(429, "Guest rate limit reached. Please wait and try again.")
    recent.append(now)
    GUEST_HITS[ip] = recent


def session_history(req: ChatRequest) -> list[dict]:
    if req.session_id and req.session_id in SESSIONS:
        return SESSIONS[req.session_id][-MAX_SESSION_MESSAGES:]
    return req.history[-20:]


def save_session(session_id: Optional[str], history: list[dict]) -> None:
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
_ALLOWED_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}


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


def local_response(message: str) -> Optional[str]:
    text = message.strip().lower()
    if re.fullmatch(r"(what('s| is) )?(the )?time( right now)?\??", text):
        return datetime.now().astimezone().strftime("It is %I:%M %p.")
    if re.fullmatch(r"(what('s| is) )?(today('s)? )?date\??", text):
        return datetime.now().astimezone().strftime("Today is %A, %B %d, %Y.")
    if re.fullmatch(r"(hi|hello|hey)( jarvis)?[!. ]*", text):
        return "Hello. JARVIS is online and ready."
    if text in {"who are you", "what are you", "what is jarvis"}:
        return "I am JARVIS, your personal AI assistant."
    if re.fullmatch(r"(calculate|compute)\s+.+", text):
        result = safe_calculate(re.sub(r"^(calculate|compute)\s+", "", message.strip(), flags=re.I))
        if result is not None:
            return result
    return None


def build_input(history: list[dict], message: str) -> list[dict]:
    items = []
    for item in history[-20:]:
        role = item.get("role")
        content = str(item.get("text", "")).strip()
        if role in {"user", "assistant"} and content:
            items.append({"role": role, "content": content})
    items.append({"role": "user", "content": message})
    return items


def openai_payload(history: list[dict], message: str) -> dict:
    return {
        "model": OPENAI_MODEL,
        "instructions": SYSTEM_PROMPT,
        "input": build_input(history, message),
        "max_output_tokens": 1200,
        "store": False,
    }


def extract_text(data: dict) -> str:
    if isinstance(data.get("output_text"), str) and data["output_text"].strip():
        return data["output_text"].strip()
    parts = []
    for item in data.get("output", []) or []:
        if item.get("type") != "message":
            continue
        for content in item.get("content", []) or []:
            if content.get("type") == "output_text" and content.get("text"):
                parts.append(content["text"])
    return "".join(parts).strip()


def generate(history: list[dict], message: str) -> str:
    try:
        response = httpx.post(
            OPENAI_URL,
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
            json=openai_payload(history, message),
            timeout=90,
        )
    except httpx.HTTPError as exc:
        raise RuntimeError(f"OpenAI connection failed: {exc}") from exc

    if response.status_code >= 400:
        try:
            detail = response.json().get("error", {}).get("message", response.text[:600])
        except Exception:
            detail = response.text[:600]
        raise RuntimeError(f"OpenAI request failed ({response.status_code}): {detail}")

    text = extract_text(response.json())
    if not text:
        raise RuntimeError("OpenAI returned an empty response")
    return text


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"] = "no-store" if request.url.path.startswith("/api/") else "public, max-age=300"
    return response


@app.get("/health")
def health():
    return {"ok": True, "service": APP_NAME, "model": OPENAI_MODEL, "openai_configured": bool(OPENAI_API_KEY), "sessions": len(SESSIONS)}


@app.get("/api/status")
def status(request: Request, authorization: Optional[str] = Header(default=None)):
    authenticate(request, authorization)
    return {"ok": True, "service": APP_NAME, "model": OPENAI_MODEL, "openai_configured": bool(OPENAI_API_KEY), "sessions": len(SESSIONS)}


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest, request: Request, authorization: Optional[str] = Header(default=None)):
    authenticate(request, authorization)
    if not OPENAI_API_KEY:
        raise HTTPException(503, "OPENAI_API_KEY is not configured")

    message = req.message.strip()
    fast = local_response(message)
    if fast is not None:
        return ChatResponse(reply=fast, model=OPENAI_MODEL, session_id=req.session_id)

    prior = session_history(req)
    try:
        reply = generate(prior, message)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc

    save_session(req.session_id, prior + [{"role": "user", "text": message}, {"role": "assistant", "text": reply}])
    return ChatResponse(reply=reply, model=OPENAI_MODEL, session_id=req.session_id)


@app.post("/api/chat/stream")
def chat_stream(req: ChatRequest, request: Request, authorization: Optional[str] = Header(default=None)):
    authenticate(request, authorization)
    if not OPENAI_API_KEY:
        raise HTTPException(503, "OPENAI_API_KEY is not configured")

    message = req.message.strip()
    fast = local_response(message)
    if fast is not None:
        def fast_events():
            yield f"data: {json.dumps({'text': fast}, ensure_ascii=False)}\\n\\n"
            yield "data: [DONE]\\n\\n"
        return StreamingResponse(fast_events(), media_type="text/event-stream")

    prior = session_history(req)

    def events():
        parts = []
        completed_text = ""
        try:
            with httpx.stream(
                "POST",
                OPENAI_URL,
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json", "Accept": "text/event-stream"},
                json={**openai_payload(prior, message), "stream": True},
                timeout=90,
            ) as response:
                if response.status_code >= 400:
                    body = response.read().decode("utf-8", errors="replace")
                    try:
                        detail = json.loads(body).get("error", {}).get("message", body[:600])
                    except Exception:
                        detail = body[:600]
                    raise RuntimeError(f"OpenAI request failed ({response.status_code}): {detail}")

                for line in response.iter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if raw == "[DONE]":
                        continue
                    try:
                        event = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    if event.get("type") == "response.output_text.delta":
                        delta = event.get("delta", "")
                        if delta:
                            parts.append(delta)
                            yield f"data: {json.dumps({'text': delta}, ensure_ascii=False)}\\n\\n"
                    elif event.get("type") == "response.completed":
                        completed_text = extract_text(event.get("response", {}))

            reply = "".join(parts).strip()
            if not reply:
                reply = completed_text.strip()
            if not reply:
                reply = generate(prior, message)
                yield f"data: {json.dumps({'text': reply}, ensure_ascii=False)}\\n\\n"

            save_session(req.session_id, prior + [{"role": "user", "text": message}, {"role": "assistant", "text": reply}])
            yield "data: [DONE]\\n\\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)[:600]}, ensure_ascii=False)}\\n\\n"

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/")
def root():
    return {"service": APP_NAME, "message": "JARVIS backend is online. Use /health or /api/chat."}
