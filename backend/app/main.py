import os
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
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
MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
AUTH_TOKEN = os.getenv("JARVIS_AUTH_TOKEN", "").strip()

SYSTEM = """
You are JARVIS, a personal AI assistant.

Be intelligent, concise, practical, and honest.

Never claim that you performed an action unless a connected tool actually performed it.

If a capability is unavailable, clearly explain that it is unavailable.

For dangerous, destructive, financial, account, or communication actions,
require confirmation before execution.

You should help the user accomplish tasks efficiently and ask for clarification
only when it is genuinely necessary.
"""


class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []
    session_id: Optional[str] = None


class ChatResponse(BaseModel):
    reply: str
    model: str


def check_auth(authorization: Optional[str]):
    if AUTH_TOKEN and authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(
            status_code=401,
            detail="Invalid JARVIS authentication token"
        )


@app.get("/health")
def health():
    return {
        "ok": True,
        "gemini_configured": bool(API_KEY),
        "model": MODEL
    }


@app.post("/api/chat", response_model=ChatResponse)
def chat(
    req: ChatRequest,
    authorization: Optional[str] = Header(default=None)
):
    check_auth(authorization)

    if not API_KEY:
        raise HTTPException(
            status_code=503,
            detail="GEMINI_API_KEY is not configured"
        )

    if not req.message.strip():
        raise HTTPException(
            status_code=400,
            detail="Message is empty"
        )

    client = genai.Client(api_key=API_KEY)

    contents = []

    for item in req.history[-20:]:
        role = item.get("role", "user")
        text = str(item.get("text", "")).strip()

        if text:
            contents.append({
                "role": "model" if role == "assistant" else "user",
                "parts": [{"text": text}]
            })

    contents.append({
        "role": "user",
        "parts": [{"text": req.message.strip()}]
    })

    try:
        result = client.models.generate_content(
            model=MODEL,
            contents=contents,
            config={
                "system_instruction": SYSTEM,
                "temperature": 0.7
            }
        )

        reply = (result.text or "").strip()

        if not reply:
            reply = "I received the request, but Gemini returned no text."

        return ChatResponse(
            reply=reply,
            model=MODEL
        )

    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini request failed: {exc}"
        )
