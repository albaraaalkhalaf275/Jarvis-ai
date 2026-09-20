const messages = document.getElementById("messages");
const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const micButton = document.getElementById("micButton");
const sendButton = document.getElementById("sendButton");

const statusText = document.getElementById("statusText");
const subtitle = document.getElementById("subtitle");
const commandState = document.getElementById("commandState");

const settingsButton = document.getElementById("settingsButton");
const settingsPanel = document.getElementById("settingsPanel");
const closeSettings = document.getElementById("closeSettings");
const saveSettings = document.getElementById("saveSettings");
const backendUrlInput = document.getElementById("backendUrl");
const sideMenu = document.getElementById("sideMenu");
const menuButton = document.getElementById("menuButton");
const closeMenu = document.getElementById("closeMenu");
const sideMenuBackdrop = document.getElementById("sideMenuBackdrop");
const memoryPanel = document.getElementById("memoryPanel");
const memoryBackdrop = document.getElementById("memoryBackdrop");
const closeMemory = document.getElementById("closeMemory");
const memoryList = document.getElementById("memoryList");
const memoryBadge = document.getElementById("memoryBadge");
const memoryCount = document.getElementById("memoryCount");
const newChatButton = document.getElementById("newChatButton");
const clearMemory = document.getElementById("clearMemory");
const systemStatusNav = document.getElementById("systemStatusNav");
const systemStatusMenu = document.getElementById("systemStatusMenu");
const closeSystemStatus = document.getElementById("closeSystemStatus");
const menuStatusBadge = document.getElementById("menuStatusBadge");

let backendUrl = "";
let busy = false;
let recognition = null;
let currentAudio = null;
let authClient = null;
let authSession = null;
let isOwner = false;
let backendFailures = 0;
let lastBackendCheck = 0;

function readStorage(key, fallback = "") {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writeStorage(key, value) {
    try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function safeJSON(key, fallback) {
    try { return JSON.parse(readStorage(key, JSON.stringify(fallback))); } catch { return fallback; }
}
function newId() {
    return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
}


function setAuthStatus(text) {
    if (authStatus) authStatus.textContent = text;
}
function setSubtitle(text) {
    if (subtitle) subtitle.textContent = text;
}
async function loadPublicSupabaseConfig() {
    if (!backendUrl) return;
    try {
        const response = await fetchWithTimeout(backendUrl + "/api/config?ts=" + Date.now(), {cache:"no-store"}, 8000);
        if (!response.ok) return;
        const config = await response.json();
        if (config.supabase_url && config.supabase_publishable_key) {
            savedSupabaseUrl = String(config.supabase_url).replace(/\/$/, "");
            savedSupabaseKey = String(config.supabase_publishable_key);
            writeStorage("jarvis_supabase_url", savedSupabaseUrl);
            writeStorage("jarvis_supabase_key", savedSupabaseKey);
            if (supabaseUrlInput) supabaseUrlInput.value = savedSupabaseUrl;
            if (supabaseKeyInput) supabaseKeyInput.value = savedSupabaseKey;
        }
    } catch {}
}
function handleAuthRedirectError() {
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const error = params.get("error_description") || params.get("error");
    if (error) {
        setAuthStatus(decodeURIComponent(error.replace(/\+/g, " ")));
        authPanel?.classList.remove("hidden");
        history.replaceState(null, "", window.location.pathname + window.location.search);
    }
}

function applyOwnerUI(owner) {
    isOwner = Boolean(owner);
    if (settingsButton) settingsButton.hidden = !isOwner;
    document.querySelectorAll(".owner-only").forEach(el => { el.hidden = !isOwner; });
}

function setAccountLabel() {
    if (!accountButton) return;
    if (authSession?.user) {
        const name = authSession.user.user_metadata?.full_name || authSession.user.email || "ACCOUNT";
        accountButton.textContent = "◉ " + String(name).split(" ")[0].slice(0, 14).toUpperCase();
        if (signOutButton) signOutButton.classList.remove("hidden");
    } else {
        accountButton.textContent = "◉ ACCOUNT";
        if (signOutButton) signOutButton.classList.add("hidden");
    }
    if (!authSession) applyOwnerUI(false);
}
async function initAuth() {
    savedSupabaseUrl = readStorage("jarvis_supabase_url");
    savedSupabaseKey = readStorage("jarvis_supabase_key");
    await loadPublicSupabaseConfig();
    if (!window.supabase || !savedSupabaseUrl || !savedSupabaseKey) {
        setAuthStatus("Guest mode is available. Account sign-in is not configured yet.");
        setAccountLabel();
        return;
    }
    try {
        authClient = window.supabase.createClient(savedSupabaseUrl, savedSupabaseKey);
        const result = await authClient.auth.getSession();
        authSession = result.data?.session || null;
        setAccountLabel();
        await syncOwnerAccess();
        authClient.auth.onAuthStateChange((_event, session) => {
            authSession = session;
            setAccountLabel();
            void syncOwnerAccess().then(() => {
                if (session) {
                    setAuthStatus("Signed in. Your JARVIS session is authenticated.");
                    checkBackend();
                }
            });
        });
    } catch {
        setAuthStatus("Account service is not configured correctly. Guest mode remains available.");
    }
}
async function syncOwnerAccess() {
    applyOwnerUI(false);
    try {
        const headers = {};
        if (authSession?.access_token) headers.Authorization = "Bearer " + authSession.access_token;
        const response = await fetchWithTimeout(backendUrl + "/api/me", {headers, cache:"no-store"}, 8000);
        if (!response.ok) return false;
        const data = await response.json();
        applyOwnerUI(Boolean(data.owner));
        return Boolean(data.owner);
    } catch {
        return false;
    }
}

async function signInProvider(provider) {
    if (!authClient) {
        setAuthStatus("Account sign-in is not configured yet.");
        return;
    }
    setAuthStatus("Opening " + provider + " sign-in...");
    const { data, error } = await authClient.auth.signInWithOAuth({
        provider,
        options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if (error) {
        setAuthStatus(error.message);
        return;
    }
    if (!data?.url) setAuthStatus("The " + provider + " sign-in provider did not return an authorization URL.");
}

backendUrl = (readStorage("jarvis_backend_url") || "https://jarvis-ai-uhe3.onrender.com").trim().replace(/\/$/, "");
backendUrlInput.value = backendUrl;

const supabaseUrlInput = document.getElementById("supabaseUrl");
const supabaseKeyInput = document.getElementById("supabaseKey");
const accountButton = document.getElementById("accountButton");
const authPanel = document.getElementById("authPanel");
const closeAuth = document.getElementById("closeAuth");
const guestButton = document.getElementById("guestButton");
const googleButton = document.getElementById("googleButton");
const appleButton = document.getElementById("appleButton");
const authStatus = document.getElementById("authStatus");
const signOutButton = document.getElementById("signOutButton");
let savedSupabaseUrl = readStorage("jarvis_supabase_url");
let savedSupabaseKey = readStorage("jarvis_supabase_key");
if (supabaseUrlInput) supabaseUrlInput.value = savedSupabaseUrl;
if (supabaseKeyInput) supabaseKeyInput.value = savedSupabaseKey;

let archives = safeJSON("jarvis_conversations", []);
let currentChat = safeJSON("jarvis_current_chat", null);

// Every fresh website load starts a new chat. The previous chat is archived first.
if (currentChat && Array.isArray(currentChat.messages) && currentChat.messages.length) {
    archiveCurrentChat();
}
let sessionId = newId();
let history = [];
currentChat = { id: sessionId, title: "New conversation", createdAt: Date.now(), messages: [] };
writeStorage("jarvis_session_id", sessionId);
saveCurrentChat();

function archiveCurrentChat() {
    if (!currentChat || !currentChat.messages?.length) return;
    const copy = {
        ...currentChat,
        messages: currentChat.messages.slice(),
        archivedAt: Date.now()
    };
    archives = [copy, ...archives.filter(item => item.id !== copy.id)].slice(0, 50);
    writeStorage("jarvis_conversations", JSON.stringify(archives));
}

function saveCurrentChat() {
    currentChat.messages = history.slice(-100);
    writeStorage("jarvis_current_chat", JSON.stringify(currentChat));
    renderMemory();
}

function addMessage(text, type) {
    const element = document.createElement("div");
    element.className = "message " + type;
    element.textContent = text;
    messages.appendChild(element);
    messages.scrollTop = messages.scrollHeight;
}

function renderHistory() {
    messages.innerHTML = "";
    history.forEach(item => addMessage(item.text, item.role === "user" ? "user" : "jarvis"));
    renderActivity();
}

function renderActivity() {
    const list = document.getElementById("activityList");
    const count = document.getElementById("activityCount");
    if (!list) return;
    const events = history.slice(-5).reverse();
    if (count) count.textContent = history.length ? Math.ceil(history.length / 2) + " EVENTS" : "0 EVENTS";
    if (!events.length) {
        list.innerHTML = '<div class="empty-state">No activity in this session.</div>';
        return;
    }
    list.innerHTML = events.map(item => {
        const time = new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
        const text = String(item.text || "").replace(/[<>]/g, "").slice(0, 90);
        return '<div class="activity-row"><time>' + time + '</time><span>' + (item.role === "user" ? "Command: " : "JARVIS: ") + text + '</span></div>';
    }).join("");
}

function renderMemory() {
    const count = archives.length;
    if (memoryBadge) memoryBadge.textContent = count;
    if (memoryCount) memoryCount.textContent = String(count);
    if (!memoryList) return;
    if (!count) {
        memoryList.innerHTML = '<div class="empty-state">No saved conversations yet.</div>';
        return;
    }
    memoryList.innerHTML = archives.map(chat => {
        const last = chat.messages?.[chat.messages.length - 1]?.text || "Empty conversation";
        const date = new Date(chat.archivedAt || chat.createdAt).toLocaleString([], {month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"});
        const title = escapeHTML(chat.title || "Conversation");
        const preview = escapeHTML(last.slice(0, 90));
        return '<button class="memory-item" data-chat-id="' + chat.id + '"><strong>' + title + '</strong><em>OPEN ›</em><small>' + date + ' • ' + preview + '</small></button>';
    }).join("");
}

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

function setMenu(open) {
    if (!sideMenu) return;
    sideMenu.classList.toggle("open", open);
    sideMenu.setAttribute("aria-hidden", String(!open));
    menuButton?.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("menu-open", open);
}
function setMemory(open) {
    memoryPanel?.setAttribute("aria-hidden", String(!open));
    if (open) renderMemory();
}
function startNewChat() {
    archiveCurrentChat();
    sessionId = newId();
    history = [];
    currentChat = {id: sessionId, title: "New conversation", createdAt: Date.now(), messages: []};
    writeStorage("jarvis_session_id", sessionId);
    saveCurrentChat();
    renderHistory();
    setMemory(false);
    setMenu(false);
    setSubtitle("New conversation ready.");
    commandState.textContent = "NEW CHAT";
    setTimeout(() => commandState.textContent = "READY", 900);
    messageInput.focus();
}

function openArchivedChat(id) {
    const chat = archives.find(item => item.id === id);
    if (!chat) return;
    sessionId = chat.id;
    history = Array.isArray(chat.messages) ? chat.messages.slice() : [];
    currentChat = {...chat, messages: history.slice(), restoredAt: Date.now()};
    writeStorage("jarvis_session_id", sessionId);
    saveCurrentChat();
    renderHistory();
    setMemory(false);
    setMenu(false);
    setSubtitle("Memory restored. Continue this conversation.");
    commandState.textContent = "MEMORY RESTORED";
    setTimeout(() => commandState.textContent = "READY", 1100);
    messageInput.focus();
}

function setStatus(online, text) {
    statusText.textContent = text;
    const model = document.getElementById("modelValue");
    if (model) model.textContent = online ? (window.jarvisModel || "ONLINE") : "--";
    const voice = document.getElementById("voiceValue");
    if (voice) voice.textContent = online ? "READY" : "OFFLINE";
}

function setBusy(value) {
    busy = value;
    if (sendButton) sendButton.disabled = value;
    if (messageInput) messageInput.disabled = value;
    if (micButton) micButton.disabled = value;
    commandState.textContent = value ? "PROCESSING" : "READY";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, {...options, signal: controller.signal}); }
    finally { clearTimeout(timer); }
}

async function checkBackend() {
    if (!backendUrl) {
        setStatus(false, "NOT CONFIGURED");
        setSubtitle("Open Settings to connect JARVIS.");
        return false;
    }
    const now = Date.now();
    if (now - lastBackendCheck < 3000) return statusText.textContent === "ONLINE";
    lastBackendCheck = now;
    if (backendFailures === 0) setStatus(false, "CONNECTING");
    try {
        const response = await fetchWithTimeout(backendUrl + "/health?ts=" + now, {cache:"no-store"}, 12000);
        if (!response.ok) throw new Error("HTTP " + response.status);
        const data = await response.json();
        window.jarvisModel = data.model || "ONLINE";
        if (!data.gemini_configured) throw new Error("Gemini is not configured");
        backendFailures = 0;
        setStatus(true, "ONLINE");
        setSubtitle("JARVIS systems operational.");
        document.getElementById("voiceStatus").textContent = data.tts_configured ? "ONLINE" : "FALLBACK";
        document.getElementById("systemFoot").textContent = "ALL SYSTEMS OPERATIONAL";
        return true;
    } catch (error) {
        backendFailures += 1;
        if (backendFailures >= 3) {
            setStatus(false, "OFFLINE");
            setSubtitle(error.name === "AbortError" ? "Backend is waking up or unavailable." : "Backend connection unavailable. Retrying automatically.");
            document.getElementById("systemFoot").textContent = "AUTO-RECONNECT ACTIVE";
        } else {
            setStatus(false, "CONNECTING");
            setSubtitle("Connecting to JARVIS...");
            document.getElementById("systemFoot").textContent = "RETRYING CONNECTION";
        }
        return false;
    }
}

function getJarvisMode(message) {
    const text = String(message || "").toLowerCase();
    if (/\b(fun mode|time for fun|let's have fun|lets have fun|mess around|joke mode|be funny)\b/.test(text)) return "fun";
    if (/\b(serious mode|duty mode|back to work|focus mode|be serious)\b/.test(text)) return "duty";
    return null;
}

async function sendMessage(message) {
    message = String(message || "").trim();
    if (!message || busy) return;
    if (!backendUrl) {
        addMessage("Backend is not configured. Open Settings and enter your JARVIS backend URL.", "jarvis");
        return;
    }

    const historyForRequest = history.filter(item => item.role === "user" || item.role === "assistant").slice(-10);
    addMessage(message, "user");
    history.push({role:"user", text:message});
    if (currentChat.title === "New conversation") currentChat.title = message.slice(0, 42);
    saveCurrentChat();
    renderActivity();

    messageInput.value = "";
    setSubtitle("Processing request...");
    setBusy(true);

    try {
        const headers = {"Content-Type":"application/json"};
        // Normal chat uses the current Supabase session only.
        // Do not send the legacy JARVIS_AUTH_TOKEN from browser storage to chat endpoints.
        if (authSession?.access_token) headers.Authorization = "Bearer " + authSession.access_token;
        const response = await fetchWithTimeout(backendUrl + "/api/chat/stream", {
            method:"POST", headers,
            body:JSON.stringify({message, history:historyForRequest, session_id:sessionId})
        }, 60000);

        if (!response.ok) {
            let detail = "Request failed (HTTP " + response.status + ")";
            try {
                const data = await response.json();
                detail = data.detail || detail;
            } catch {}
            throw new Error(detail);
        }

        if (!response.body) throw new Error("Streaming is not supported by this browser.");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let reply = "";
        let replyElement = null;

        const appendChunk = chunk => {
            reply += chunk;
            if (!replyElement) {
                replyElement = document.createElement("div");
                replyElement.className = "message jarvis";
                messages.appendChild(replyElement);
            }
            replyElement.textContent = reply;
            messages.scrollTop = messages.scrollHeight;
            setSubtitle("JARVIS is responding...");
        };

        let done = false;
        while (!done) {
            const result = await reader.read();
            done = result.done;
            buffer += decoder.decode(result.value || new Uint8Array(), {stream: !done});
            const events = buffer.split("\\n\\n");
            buffer = events.pop() || "";

            for (const event of events) {
                const line = event.split("\\n").find(item => item.startsWith("data:"));
                if (!line) continue;
                const payload = line.slice(5).trim();
                if (payload === "[DONE]") continue;
                let data;
                try { data = JSON.parse(payload); } catch { continue; }
                if (data.error) throw new Error(data.error);
                if (data.text) appendChunk(String(data.text));
            }
        }

        if (buffer.trim()) {
            const line = buffer.split("\\n").find(item => item.startsWith("data:"));
            if (line) {
                const payload = line.slice(5).trim();
                if (payload && payload !== "[DONE]") {
                    try {
                        const data = JSON.parse(payload);
                        if (data.error) throw new Error(data.error);
                        if (data.text) appendChunk(String(data.text));
                    } catch (error) {
                        if (error.message && !error.message.startsWith("Unexpected token")) throw error;
                    }
                }
            }
        }

        reply = reply.trim() || "No response received.";
        if (replyElement) replyElement.textContent = reply;
        else addMessage(reply, "jarvis");
        history.push({role:"assistant", text:reply});
        saveCurrentChat();
        renderActivity();
        setStatus(true, "ONLINE");
        setSubtitle("Awaiting your command.");
        void speak(reply);
    } catch (error) {
        const errorMessage = error.name === "AbortError" ? "JARVIS timed out waiting for the backend." : "Connection error: " + error.message;
        addMessage(errorMessage, "jarvis");
        setSubtitle("Request failed. Check the connection.");
        checkBackend();
    } finally {
        setBusy(false);
        messageInput.focus();
    }
}

chatForm.addEventListener("submit", event => { event.preventDefault(); sendMessage(messageInput.value); });
document.querySelectorAll("[data-command]").forEach(button => {
    button.addEventListener("click", () => {
        const command = button.dataset.command;
        setMenu(false);
        if (command) sendMessage(command);
    });
});

function focusSection(section) {
    setMenu(false);
    const target = document.querySelector(section);
    if (target) target.scrollIntoView({behavior:"smooth", block:"start"});
}

document.querySelectorAll(".nav-item[data-command]").forEach(button => {
    button.addEventListener("click", event => {
        event.preventDefault();
        const command = button.dataset.command || "";
        setMenu(false);
        if (button.textContent.includes("DASHBOARD")) {
            window.scrollTo({top:0, behavior:"smooth"});
            return;
        }
        if (command) sendMessage(command);
    });
});

menuButton?.addEventListener("click", () => setMenu(true));
closeMenu?.addEventListener("click", () => setMenu(false));
sideMenuBackdrop?.addEventListener("click", () => setMenu(false));

document.getElementById("memoryNav")?.addEventListener("click", () => { setMenu(false); setMemory(true); });
closeMemory?.addEventListener("click", () => setMemory(false));
memoryBackdrop?.addEventListener("click", () => setMemory(false));
memoryList?.addEventListener("click", event => {
    const item = event.target.closest(".memory-item");
    if (item) openArchivedChat(item.dataset.chatId);
});
newChatButton?.addEventListener("click", startNewChat);
clearMemory?.addEventListener("click", () => {
    if (!confirm("Clear all saved conversations?")) return;
    archives = [];
    writeStorage("jarvis_conversations", "[]");
    renderMemory();
});

settingsButton?.addEventListener("click", () => {
    if (!isOwner) return;
    setMenu(false);
    settingsPanel.classList.remove("hidden");
    backendUrlInput.value = backendUrl;
});
closeSettings?.addEventListener("click", () => settingsPanel.classList.add("hidden"));
accountButton?.addEventListener("click", () => { setMenu(false); authPanel?.classList.remove("hidden"); });
closeAuth?.addEventListener("click", () => authPanel?.classList.add("hidden"));
guestButton?.addEventListener("click", async () => {
    if (authClient && authSession) {
        try { await authClient.auth.signOut(); } catch {}
    }
    authSession = null;
    setAccountLabel();
    setAuthStatus("Guest mode active. Your conversations remain local on this device.");
    authPanel?.classList.add("hidden");
    checkBackend();
});
googleButton?.addEventListener("click", () => signInProvider("google"));
appleButton?.addEventListener("click", () => signInProvider("apple"));


signOutButton?.addEventListener("click", async () => {
    if (authClient) await authClient.auth.signOut();
    authSession = null;
    setAccountLabel();
    setAuthStatus("Signed out. Guest mode is still available.");
});
saveSettings?.addEventListener("click", async () => {
    const enteredBackendUrl = backendUrlInput.value.trim().replace(/\/$/, "");
    if (enteredBackendUrl) { backendUrl = enteredBackendUrl; writeStorage("jarvis_backend_url", backendUrl); }
    backendUrlInput.value = backendUrl;
    settingsPanel.classList.add("hidden");
    await initAuth();
    await checkBackend();
});

function speakWithBrowser(text) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = .9; utterance.pitch = .85; utterance.volume = 1;
    const voices = window.speechSynthesis.getVoices();
    const britishMale = voices.find(v => /^en-GB/i.test(v.lang) && /male|ryan|daniel|arthur|oliver|george/i.test(v.name));
    if (britishMale) utterance.voice = britishMale;
    window.speechSynthesis.speak(utterance);
}

async function speak(text) {
    if (!backendUrl) { speakWithBrowser(text); return; }
    if (currentAudio) { currentAudio.pause(); currentAudio.currentTime = 0; currentAudio = null; }
    const headers = {"Content-Type":"application/json"};
    // Normal TTS uses the current Supabase session only.
    // Do not send the legacy JARVIS_AUTH_TOKEN from browser storage.
    if (authSession?.access_token) headers.Authorization = "Bearer " + authSession.access_token;
    try {
        const response = await fetchWithTimeout(backendUrl + "/api/speak", {
            method:"POST", headers, body:JSON.stringify({text})
        }, 30000);
        if (!response.ok) throw new Error("TTS HTTP " + response.status);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        currentAudio = new Audio(url);
        currentAudio.onended = () => { URL.revokeObjectURL(url); currentAudio = null; };
        await currentAudio.play();
    } catch { speakWithBrowser(text); }
}

if ("SpeechRecognition" in window || "webkitSpeechRecognition" in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.lang = "en-US"; recognition.interimResults = false; recognition.continuous = false;
    recognition.onstart = () => { micButton.textContent = "🔴"; setSubtitle("Listening..."); };
    recognition.onresult = event => {
        const transcript = event.results?.[0]?.[0]?.transcript?.trim();
        if (transcript) { messageInput.value = transcript; sendMessage(transcript); }
    };
    recognition.onerror = event => { micButton.textContent = "◉"; setSubtitle(event.error === "not-allowed" ? "Microphone permission was denied." : "Voice input failed."); };
    recognition.onend = () => { micButton.textContent = "◉"; };
}
micButton.addEventListener("click", () => {
    if (!recognition) { addMessage("Voice recognition is not supported by this browser.", "jarvis"); return; }
    if (!busy) try { recognition.start(); } catch {}
});

function updateClock() {
    const now = new Date();
    const hhmm = now.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", hour12:false});
    const sec = now.toLocaleTimeString([], {second:"2-digit"});
    document.getElementById("clock").textContent = hhmm;
    document.getElementById("seconds").textContent = ":" + sec;
    document.getElementById("topTime").textContent = hhmm;
    document.getElementById("date").textContent = now.toLocaleDateString([], {weekday:"long", day:"2-digit", month:"long", year:"numeric"}).toUpperCase();
    document.getElementById("lastUpdate").textContent = now.toLocaleTimeString([], {hour12:false});
}
setInterval(updateClock, 1000);
updateClock();

handleAuthRedirectError();
renderHistory();
renderMemory();
initAuth().finally(() => checkBackend());
setInterval(() => checkBackend(), 15000);
messageInput.focus();

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));


// Keep dashboard status cards synchronized with the live connection state.
(function syncDashboardStatus() {
    const root = document.querySelector('.app');
    const statusText = document.getElementById('statusText');
    const footerStatus = document.getElementById('footerStatus');
    const backendStatus = document.getElementById('backendStatus');
    const connectionValue = document.getElementById('connectionValue');
    const aiStatus = document.getElementById('aiStatus');
    const voiceStatus = document.getElementById('voiceStatus');
    const statusLabel = document.getElementById('statusLabel');
    const coreCaption = null;
    function sync() {
        const state = statusText ? statusText.textContent.trim() : 'OFFLINE';
        const online = state === 'ONLINE';
        const connecting = state === 'CONNECTING';
        root?.classList.toggle('online', online);
        const displayState = online ? 'ONLINE' : connecting ? 'CONNECTING' : state;
        if (footerStatus) footerStatus.textContent = displayState;
        if (backendStatus) backendStatus.textContent = displayState;
        if (connectionValue) connectionValue.textContent = displayState;
        if (aiStatus) aiStatus.textContent = displayState;
        if (voiceStatus) voiceStatus.textContent = online ? 'READY' : connecting ? 'CONNECTING' : 'OFFLINE';
        if (statusLabel) statusLabel.textContent = online ? 'OPERATIONAL' : connecting ? 'CONNECTING' : state;
        if (menuStatusBadge) menuStatusBadge.textContent = online ? 'ONLINE' : connecting ? 'CONNECTING' : state;

    }
    if (statusText) new MutationObserver(sync).observe(statusText, {childList:true,subtree:true,characterData:true});
    sync();
})();
