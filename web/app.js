const $ = (id) => document.getElementById(id);

const messages = $("messages");
const form = $("chatForm");
const input = $("messageInput");
const send = $("sendButton");
const statusText = $("statusText");
const statusDot = $("statusDot");
const modelText = $("modelText");
const coreState = $("coreState");
const menu = $("menu");
const menuButton = $("menuButton");
const closeMenu = $("closeMenu");
const menuBackdrop = $("menuBackdrop");
const newChat = $("newChat");
const clearChat = $("clearChat");
const backendInfo = $("backendInfo");
const menuModel = $("menuModel");

const BACKEND_URL = (localStorage.getItem("jarvis_backend_url") || "https://jarvis-ai-uhe3.onrender.com").replace(/\/$/, "");
let sessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
let history = [];
let busy = false;

function setStatus(ok, text) {
  statusText.textContent = text;
  statusDot.classList.toggle("online", ok);
  backendInfo.textContent = ok ? "ONLINE" : "OFFLINE";
}

function addMessage(text, role) {
  const el = document.createElement("div");
  el.className = "message " + role;
  el.textContent = text;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
  return el;
}

function resetChat() {
  sessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  history = [];
  messages.innerHTML = "";
  coreState.textContent = "STANDBY";
  input.focus();
}

async function checkHealth() {
  try {
    const r = await fetch(BACKEND_URL + "/health", {cache:"no-store"});
    if (!r.ok) throw new Error();
    const data = await r.json();
    setStatus(Boolean(data.ok && data.openai_configured), data.ok && data.openai_configured ? "ONLINE" : "CONFIG NEEDED");
    modelText.textContent = data.openai_configured ? data.model : "OpenAI API key required";
    menuModel.textContent = data.model || "--";
    return true;
  } catch {
    setStatus(false, "OFFLINE");
    modelText.textContent = "Backend unavailable";
    return false;
  }
}

async function sendMessage(text) {
  if (!text || busy) return;
  busy = true;
  send.disabled = true;
  input.value = "";
  addMessage(text, "user");
  history.push({role:"user", text});
  coreState.textContent = "THINKING";

  const replyEl = addMessage("", "assistant");
  let reply = "";

  try {
    const response = await fetch(BACKEND_URL + "/api/chat/stream", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({message:text, history:history.slice(-20), session_id:sessionId})
    });

    if (!response.ok) {
      let detail = "Request failed";
      try { detail = (await response.json()).detail || detail; } catch {}
      throw new Error(detail);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const consume = (block) => {
      const line = block.split("\n").find(x => x.startsWith("data:"));
      if (!line) return;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") return;
      const data = JSON.parse(raw);
      if (data.error) throw new Error(data.error);
      if (data.text) {
        reply += data.text;
        replyEl.textContent = reply;
        messages.scrollTop = messages.scrollHeight;
      }
    };

    while (true) {
      const {done, value} = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), {stream:!done});
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) consume(block);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);

    if (!reply) throw new Error("JARVIS returned an empty response.");
    history.push({role:"assistant", text:reply});
    setStatus(true, "ONLINE");
    coreState.textContent = "STANDBY";
  } catch (error) {
    replyEl.remove();
    addMessage("JARVIS error: " + error.message, "assistant");
    coreState.textContent = "ERROR";
    setStatus(false, "ERROR");
  } finally {
    busy = false;
    send.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(input.value.trim());
});

menuButton.addEventListener("click", () => { menu.classList.add("open"); menu.setAttribute("aria-hidden","false"); });
closeMenu.addEventListener("click", () => { menu.classList.remove("open"); menu.setAttribute("aria-hidden","true"); });
menuBackdrop.addEventListener("click", () => closeMenu.click());
newChat.addEventListener("click", () => { resetChat(); closeMenu.click(); });
clearChat.addEventListener("click", () => { messages.innerHTML = ""; history = []; closeMenu.click(); input.focus(); });

checkHealth();
setInterval(checkHealth, 30000);
input.focus();
