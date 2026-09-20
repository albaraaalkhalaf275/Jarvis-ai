import ast
import math
import operator
import os
import re
from datetime import datetime, timezone
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
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


def check_auth(authorization: Optional[str]):
    if AUTH_TOKEN and authorization != f"Bearer {AUTH_TOKEN}":
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

    if re.fullmatch(r"(calculate|compute)\s+.+", text):
        expression = re.sub(r"^(calculate|compute)\s+", "", message.strip(), flags=re.I)
        result = safe_calculate(expression)
        if result is not None:
            return result

    return None


@app.get("/health")
def health():
    return {
        "ok": True,
        "gemini_configured": bool(API_KEY),
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
        "model": MODEL,
        "active_sessions": len(SESSIONS),
        "capabilities": [
            "chat",
            "conversation context",
            "voice through the web client",
            "text-to-speech through the web client",
            "time",
            "date",
            "calculator",
        ],
    }


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest, authorization: Optional[str] = Header(default=None)):
    check_auth(authorization)

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

    try:
        result = client.models.generate_content(
            model=MODEL,
            contents=contents,
            config={
                "system_instruction": SYSTEM,
                "temperature": 0.7,
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
