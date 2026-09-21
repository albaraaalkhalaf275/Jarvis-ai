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
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

APP_NAME = "JARVIS"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.6").strip()
OPENAI_URL = "https://api.openai.com/v1/responses"
OPENAI_FILES_URL = "https://api.openai.com/v1/files"
ALLOW_GUEST = os.getenv("ALLOW_GUEST", "true").lower() in {"1", "true", "yes"}
FRONTEND_ORIGINS = [x.strip() for x in os.getenv("FRONTEND_ORIGINS", "*").split(",") if x.strip()]
ALLOWED_HOSTS = [x.strip() for x in os.getenv("ALLOWED_HOSTS", "*.onrender.com,localhost,127.0.0.1").split(",") if x.strip()]

SYSTEM_PROMPT = """You are JARVIS, a capable personal AI assistant.
Be accurate, direct, useful, and honest about uncertainty.
Answer the user's actual request first. Use supplied conversation context.
Use tools when they materially improve the answer.
Never invent facts, actions, sources, or tool results.
If a capability is unavailable, state that clearly instead of pretending.
Important external, destructive, financial, privacy-sensitive, account-changing, or communication actions require confirmation.
"""

app = FastAPI(title=APP_NAME, docs_url=None, redoc_url=None)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if FRONTEND_ORIGINS == ["*"] else FRONTEND_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
app.add_middleware(GZipMiddleware, minimum_size=1000)

GUEST_HITS: dict[str, list[float]] = defaultdict(list)
SESSIONS: dict[str, list[dict]] = {}
MAX_SESSION_MESSAGES = 40
GUEST_RATE_LIMIT = 60
GUEST_RATE_WINDOW = 60
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=12000)
    history: list[dict] = Field(default_factory=list, max_length=40)
    session_id: Optional[str] = Field(default=None, max_length=128)
    mode: str = Field(default="chat", max_length=32)


class ToolRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    arguments: dict = Field(default_factory=dict)


def authenticate(request: Request, authorization: Optional[str]) -> None:
    if authorization:
        if not authorization.startswith("Bearer ") or not authorization[7:].strip():
            raise HTTPException(401, "Invalid authorization header")
        raise HTTPException(401, "Authentication is not configured in this deployment")
    if not ALLOW_GUEST:
        raise HTTPException(401, "Authentication required")

    ip = request.client.host if request.client else "unknown"
    now = time.time()
    recent = [t for t in GUEST_HITS[ip] if now - t < GUEST_RATE_WINDOW]
    if len(recent) >= GUEST_RATE_LIMIT:
        raise HTTPException(429, "Guest rate limit reached. Please wait and try again.")
    recent.append(now)
    GUEST_HITS[ip] = recent


def get_history(req: ChatRequest) -> list[dict]:
    if req.session_id and req.session_id in SESSIONS:
        return SESSIONS[req.session_id][-MAX_SESSION_MESSAGES:]
    return req.history[-20:]


def save_history(session_id: Optional[str], history: list[dict]) -> None:
    if session_id:
        SESSIONS[session_id] = history[-MAX_SESSION_MESSAGES:]


_ALLOWED_BINOPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv, ast.Pow: operator.pow, ast.Mod: operator.mod}
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
            if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and math.isfinite(node.value):
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


FUNCTION_TOOLS = [
    {
        "type": "function",
        "name": "calculator",
        "description": "Evaluate a mathematical expression safely.",
        "parameters": {
            "type": "object",
            "properties": {"expression": {"type": "string"}},
            "required": ["expression"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "type": "function",
        "name": "current_time",
        "description": "Get the current local server time.",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        "strict": True,
    },
]


def run_function(name: str, arguments: str) -> str:
    try:
        args = json.loads(arguments or "{}")
    except json.JSONDecodeError:
        return "Invalid tool arguments."

    if name == "calculator":
        result = safe_calculate(str(args.get("expression", "")))
        return result if result is not None else "Invalid mathematical expression."

    if name == "current_time":
        return datetime.now().astimezone().strftime("%A, %B %d, %Y at %I:%M:%S %p %Z")

    return "Unknown function."


def openai_request(payload: dict) -> dict:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is not configured")

    try:
        response = httpx.post(
            OPENAI_URL,
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
            json=payload,
            timeout=120,
        )
    except httpx.HTTPError as exc:
        raise RuntimeError(f"OpenAI connection failed: {exc}") from exc

    if response.status_code >= 400:
        try:
            detail = response.json().get("error", {}).get("message", response.text[:600])
        except Exception:
            detail = response.text[:600]
        raise RuntimeError(f"OpenAI request failed ({response.status_code}): {detail}")

    return response.json()


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


def agent(history: list[dict], message: str, mode: str = "chat") -> str:
    input_items = build_input(history, message)
    tools = list(FUNCTION_TOOLS)
    payload = {
        "model": OPENAI_MODEL,
        "instructions": SYSTEM_PROMPT,
        "input": input_items,
        "tools": tools,
        "max_output_tokens": 2000,
        "store": False,
    }

    if mode == "search":
        payload["tools"] = [{"type": "web_search", "search_context_size": "low"}, *FUNCTION_TOOLS]
        payload["tool_choice"] = "auto"
        payload["include"] = ["web_search_call.action.sources"]

    for _ in range(8):
        data = openai_request(payload)
        calls = [item for item in data.get("output", []) or [] if item.get("type") == "function_call"]

        if not calls:
            text = extract_text(data)
            if text:
                return text
            raise RuntimeError("OpenAI returned an empty response.")

        input_items.extend(data.get("output", []))
        for call in calls:
            result = run_function(call.get("name", ""), call.get("arguments", "{}"))
            input_items.append(
                {
                    "type": "function_call_output",
                    "call_id": call.get("call_id"),
                    "output": result,
                }
            )
        payload["input"] = input_items

    raise RuntimeError("JARVIS reached its tool-call limit.")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"] = "no-store" if request.url.path.startswith("/api/") else "public, max-age=300"
    return response


@app.get("/")
def root():
    return {"service": APP_NAME, "message": "JARVIS backend is online."}


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": APP_NAME,
        "model": OPENAI_MODEL,
        "openai_configured": bool(OPENAI_API_KEY),
        "tools": len(FUNCTION_TOOLS) + 1,
        "sessions": len(SESSIONS),
    }


@app.post("/api/chat/stream")
def chat_stream(req: ChatRequest, request: Request, authorization: Optional[str] = Header(default=None)):
    authenticate(request, authorization)
    message = req.message.strip()
    prior = get_history(req)

    def events():
        try:
            fast = local_response(message)
            reply = fast if fast is not None else agent(prior, message, req.mode)
            save_history(req.session_id, prior + [{"role": "user", "text": message}, {"role": "assistant", "text": reply}])
            yield f"data: {json.dumps({'text': reply}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)[:800]}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/tools/run")
def tools_run(req: ToolRequest, request: Request, authorization: Optional[str] = Header(default=None)):
    authenticate(request, authorization)
    if req.name == "calculator":
        result = safe_calculate(str(req.arguments.get("expression", "")))
        if result is None:
            raise HTTPException(400, "Invalid mathematical expression")
        return {"ok": True, "result": result}
    if req.name == "current_time":
        return {"ok": True, "result": datetime.now().astimezone().strftime("%A, %B %d, %Y at %I:%M:%S %p %Z")}
    raise HTTPException(404, "Tool not found")


@app.post("/api/files/analyze")
async def analyze_file(
    request: Request,
    file: UploadFile = File(...),
    prompt: str = Form(default="Analyze this file and provide the key facts, structure, and useful action items."),
    authorization: Optional[str] = Header(default=None),
):
    authenticate(request, authorization)
    if not OPENAI_API_KEY:
        raise HTTPException(503, "OPENAI_API_KEY is not configured")

    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File exceeds the 25 MB JARVIS upload limit.")

    filename = file.filename or "uploaded-file"
    media_type = file.content_type or "application/octet-stream"

    try:
        upload = httpx.post(
            OPENAI_FILES_URL,
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            files={"file": (filename, content, media_type)},
            data={"purpose": "user_data"},
            timeout=120,
        )
        upload.raise_for_status()
        file_id = upload.json()["id"]

        response = openai_request(
            {
                "model": OPENAI_MODEL,
                "instructions": SYSTEM_PROMPT,
                "input": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_file", "file_id": file_id},
                            {"type": "input_text", "text": prompt[:4000]},
                        ],
                    }
                ],
                "max_output_tokens": 2400,
                "store": False,
            }
        )
        reply = extract_text(response)
        if not reply:
            raise RuntimeError("OpenAI returned an empty file-analysis response.")
        return {"ok": True, "file_id": file_id, "filename": filename, "reply": reply}
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"File analysis request failed: {exc}") from exc
    except (KeyError, RuntimeError) as exc:
        raise HTTPException(502, str(exc)) from exc
