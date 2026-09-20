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

function readStorage(key, fallback = "") {
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

function writeStorage(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}

let history = JSON.parse(readStorage("jarvis_history", "[]") || "[]");
let backendUrl = readStorage("jarvis_backend_url").trim().replace(/\/$/, "");
let authToken = readStorage("jarvis_auth_token");
let busy = false;
let recognition = null;
let currentAudio = null;
let sessionId = readStorage("jarvis_session_id");

if (!sessionId) {
    sessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    writeStorage("jarvis_session_id", sessionId);
}

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
    writeStorage("jarvis_history", JSON.stringify(history.slice(-50)));
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
        subtitle.textContent = data.tts_configured
            ? "JARVIS systems operational."
            : "JARVIS online. Neural voice not configured.";
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
        await speak(reply);
    } catch (error) {
        const errorMessage =
            error.name === "AbortError"
                ? "JARVIS timed out waiting for the backend."
                : `Connection error: ${error.message}`;

        addMessage(errorMessage, "jarvis");
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
    const enteredBackendUrl = backendUrlInput.value.trim().replace(/\/$/, "");
    const enteredAuthToken = authTokenInput.value.trim();

    if (enteredBackendUrl) {
        backendUrl = enteredBackendUrl;
        writeStorage("jarvis_backend_url", backendUrl);
    }

    if (enteredAuthToken) {
        authToken = enteredAuthToken;
        writeStorage("jarvis_auth_token", authToken);
    }

    backendUrlInput.value = backendUrl;
    authTokenInput.value = authToken;

    settingsPanel.classList.add("hidden");
    await checkBackend();
});

function speakWithBrowser(text) {
    if (!("speechSynthesis" in window)) return;

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    utterance.pitch = 0.85;
    utterance.volume = 1;

    const voices = window.speechSynthesis.getVoices();
    const britishMale = voices.find(voice =>
        /^en-GB/i.test(voice.lang) &&
        /male|ryan|daniel|arthur|oliver|george/i.test(voice.name)
    );

    if (britishMale) {
        utterance.voice = britishMale;
    }

    window.speechSynthesis.speak(utterance);
}

async function speak(text) {
    if (!backendUrl) {
        speakWithBrowser(text);
        return;
    }

    if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
    }

    const headers = {
        "Content-Type": "application/json"
    };

    if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
    }

    try {
        const response = await fetchWithTimeout(
            `${backendUrl}/api/speak`,
            {
                method: "POST",
                headers,
                body: JSON.stringify({ text })
            },
            30000
        );

        if (!response.ok) {
            throw new Error(`TTS HTTP ${response.status}`);
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        currentAudio = new Audio(url);

        currentAudio.onended = () => {
            URL.revokeObjectURL(url);
            currentAudio = null;
        };

        await currentAudio.play();
    } catch {
        // Fall back to the browser voice if Azure Speech is unavailable.
        speakWithBrowser(text);
    }
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
