const messages = document.getElementById("messages");
const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const micButton = document.getElementById("micButton");
const sendButton = document.getElementById("sendButton");

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const subtitle = document.getElementById("subtitle");

const settingsButton = document.getElementById("settingsButton");
const settingsPanel = document.getElementById("settingsPanel");
const closeSettings = document.getElementById("closeSettings");
const saveSettings = document.getElementById("saveSettings");

const backendUrlInput = document.getElementById("backendUrl");
const authTokenInput = document.getElementById("authToken");

let history = JSON.parse(localStorage.getItem("jarvis_history") || "[]");
let backendUrl = (localStorage.getItem("jarvis_backend_url") || "").trim().replace(/\/$/, "");
let authToken = localStorage.getItem("jarvis_auth_token") || "";
let busy = false;
let recognition = null;
let sessionId = localStorage.getItem("jarvis_session_id") || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
localStorage.setItem("jarvis_session_id", sessionId);

backendUrlInput.value = backendUrl;
authTokenInput.value = authToken;

function addMessage(text, type) {
    const element = document.createElement("div");
    element.className = `message ${type}`;
    element.textContent = text;
    messages.appendChild(element);
    messages.scrollTop = messages.scrollHeight;
}

function saveHistory() {
    localStorage.setItem("jarvis_history", JSON.stringify(history.slice(-50)));
}

function setStatus(online, text) {
    statusText.textContent = text;

    if (online) {
        statusDot.style.background = "#36a9ff";
        statusDot.style.boxShadow = "0 0 10px rgba(54,169,255,.8)";
    } else {
        statusDot.style.background = "#596273";
        statusDot.style.boxShadow = "0 0 8px rgba(89,98,115,.5)";
    }
}

function setBusy(value) {
    busy = value;
    if (sendButton) sendButton.disabled = value;
    if (messageInput) messageInput.disabled = value;
    if (micButton) micButton.disabled = value;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }
}

async function checkBackend() {
    if (!backendUrl) {
        setStatus(false, "NOT CONFIGURED");
        subtitle.textContent = "Open Settings to connect JARVIS.";
        return false;
    }

    setStatus(false, "CONNECTING");

    try {
        const response = await fetchWithTimeout(`${backendUrl}/health`, {}, 10000);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data.gemini_configured) {
            setStatus(false, "GEMINI ERROR");
            subtitle.textContent = "Gemini is not configured on the backend.";
            return false;
        }

        setStatus(true, "ONLINE");
        subtitle.textContent = "JARVIS systems operational.";
        return true;
    } catch (error) {
        setStatus(false, "OFFLINE");
        subtitle.textContent =
            error.name === "AbortError"
                ? "Backend connection timed out."
                : "Backend connection unavailable.";
        return false;
    }
}

async function sendMessage(message) {
    message = String(message || "").trim();

    if (!message || busy) return;

    if (!backendUrl) {
        addMessage(
            "Backend is not configured. Open Settings and enter your JARVIS backend URL.",
            "jarvis"
        );
        return;
    }

    addMessage(message, "user");

    const historyForRequest = history
        .filter(item => item && (item.role === "user" || item.role === "assistant"))
        .slice(-20);

    history.push({ role: "user", text: message });
    saveHistory();

    messageInput.value = "";
    subtitle.textContent = "Processing request...";
    setBusy(true);

    try {
        const headers = { "Content-Type": "application/json" };

        if (authToken) {
            headers.Authorization = `Bearer ${authToken}`;
        }

        const response = await fetchWithTimeout(
            `${backendUrl}/api/chat`,
            {
                method: "POST",
                headers,
                body: JSON.stringify({
                    message,
                    history: historyForRequest,
                    session_id: sessionId
                })
            },
            60000
        );

        let data;
        try {
            data = await response.json();
        } catch {
            throw new Error(`Backend returned HTTP ${response.status}`);
        }

        if (!response.ok) {
            throw new Error(data.detail || `Request failed (HTTP ${response.status})`);
        }

        const reply = String(data.reply || "No response received.").trim();

        addMessage(reply, "jarvis");
        history.push({ role: "assistant", text: reply });
        saveHistory();

        setStatus(true, "ONLINE");
        subtitle.textContent = "Awaiting your command.";
        speak(reply);
    } catch (error) {
        const message =
            error.name === "AbortError"
                ? "JARVIS timed out waiting for the backend."
                : `Connection error: ${error.message}`;

        addMessage(message, "jarvis");
        subtitle.textContent = "Request failed. Check the connection.";
        checkBackend();
    } finally {
        setBusy(false);
        messageInput.focus();
    }
}

chatForm.addEventListener("submit", event => {
    event.preventDefault();
    sendMessage(messageInput.value);
});

document.querySelectorAll(".quick-actions button").forEach(button => {
    button.addEventListener("click", () => {
        sendMessage(button.dataset.command || button.textContent);
    });
});

settingsButton.addEventListener("click", () => {
    settingsPanel.classList.remove("hidden");
    backendUrlInput.value = backendUrl;
    authTokenInput.value = authToken;
});

closeSettings.addEventListener("click", () => {
    settingsPanel.classList.add("hidden");
});

saveSettings.addEventListener("click", async () => {
    backendUrl = backendUrlInput.value.trim().replace(/\/$/, "");
    authToken = authTokenInput.value.trim();

    localStorage.setItem("jarvis_backend_url", backendUrl);
    localStorage.setItem("jarvis_auth_token", authToken);

    settingsPanel.classList.add("hidden");
    await checkBackend();
});

function speak(text) {
    if (!("speechSynthesis" in window)) return;

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 0.9;
    utterance.volume = 1;

    window.speechSynthesis.speak(utterance);
}

if ("SpeechRecognition" in window || "webkitSpeechRecognition" in window) {
    const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;

    recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => {
        if (micButton) micButton.textContent = "🔴";
        subtitle.textContent = "Listening...";
    };

    recognition.onresult = event => {
        const transcript = event.results?.[0]?.[0]?.transcript?.trim();

        if (transcript) {
            messageInput.value = transcript;
            sendMessage(transcript);
        }
    };

    recognition.onerror = event => {
        if (micButton) micButton.textContent = "🎙";
        subtitle.textContent =
            event.error === "not-allowed"
                ? "Microphone permission was denied."
                : "Voice input failed.";
    };

    recognition.onend = () => {
        if (micButton) micButton.textContent = "🎙";
    };
}

micButton.addEventListener("click", () => {
    if (!recognition) {
        addMessage(
            "Voice recognition is not supported by this browser.",
            "jarvis"
        );
        return;
    }

    if (busy) return;

    try {
        recognition.start();
    } catch {
        // Recognition was already running.
    }
});

function loadHistory() {
    messages.innerHTML = "";

    history
        .filter(item => item && (item.role === "user" || item.role === "assistant"))
        .slice(-50)
        .forEach(item => {
            addMessage(
                item.text,
                item.role === "user" ? "user" : "jarvis"
            );
        });
}

loadHistory();
checkBackend();

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
}
