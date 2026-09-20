const messages = document.getElementById("messages");
const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const micButton = document.getElementById("micButton");

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const subtitle = document.getElementById("subtitle");

const settingsButton = document.getElementById("settingsButton");
const settingsPanel = document.getElementById("settingsPanel");
const closeSettings = document.getElementById("closeSettings");
const saveSettings = document.getElementById("saveSettings");

const backendUrlInput = document.getElementById("backendUrl");
const authTokenInput = document.getElementById("authToken");

let history = JSON.parse(
    localStorage.getItem("jarvis_history") || "[]"
);

let backendUrl = localStorage.getItem(
    "jarvis_backend_url"
) || "";

let authToken = localStorage.getItem(
    "jarvis_auth_token"
) || "";

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
    localStorage.setItem(
        "jarvis_history",
        JSON.stringify(history.slice(-50))
    );
}


function setStatus(online, text) {
    statusText.textContent = text;

    if (online) {
        statusDot.style.background = "#36a9ff";
        statusDot.style.boxShadow =
            "0 0 10px rgba(54,169,255,.8)";
    } else {
        statusDot.style.background = "#596273";
        statusDot.style.boxShadow =
            "0 0 8px rgba(89,98,115,.5)";
    }
}


async function checkBackend() {
    if (!backendUrl) {
        setStatus(false, "NOT CONFIGURED");
        return;
    }

    try {
        const response = await fetch(
            `${backendUrl}/health`
        );

        if (!response.ok) {
            throw new Error("Backend unavailable");
        }

        const data = await response.json();

        if (data.gemini_configured) {
            setStatus(true, "ONLINE");
            subtitle.textContent =
                "JARVIS systems operational.";
        } else {
            setStatus(false, "GEMINI NOT CONFIGURED");
        }

    } catch (error) {
        setStatus(false, "OFFLINE");
        subtitle.textContent =
            "Backend connection unavailable.";
    }
}


async function sendMessage(message) {
    message = message.trim();

    if (!message) {
        return;
    }

    if (!backendUrl) {
        addMessage(
            "Backend is not configured. Open Settings and enter your JARVIS backend URL.",
            "jarvis"
        );
        return;
    }

    addMessage(message, "user");

    history.push({
        role: "user",
        text: message
    });

    saveHistory();

    messageInput.value = "";

    subtitle.textContent = "Processing request...";

    try {
        const headers = {
            "Content-Type": "application/json"
        };

        if (authToken) {
            headers["Authorization"] =
                `Bearer ${authToken}`;
        }

        const response = await fetch(
            `${backendUrl}/api/chat`,
            {
                method: "POST",
                headers: headers,
                body: JSON.stringify({
                    message: message,
                    history: history.slice(-20)
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.detail || "Request failed"
            );
        }

        const reply = data.reply || "No response received.";

        addMessage(reply, "jarvis");

        history.push({
            role: "assistant",
            text: reply
        });

        saveHistory();

        subtitle.textContent =
            "Awaiting your command.";

        speak(reply);

    } catch (error) {
        addMessage(
            `Connection error: ${error.message}`,
            "jarvis"
        );

        subtitle.textContent =
            "Connection error.";
    }
}


chatForm.addEventListener(
    "submit",
    function(event) {
        event.preventDefault();

        sendMessage(messageInput.value);
    }
);


document
    .querySelectorAll(".quick-actions button")
    .forEach(button => {

        button.addEventListener(
            "click",
            () => {
                sendMessage(
                    button.dataset.command
                );
            }
        );

    });


settingsButton.addEventListener(
    "click",
    () => {
        settingsPanel.classList.remove("hidden");

        backendUrlInput.value = backendUrl;
        authTokenInput.value = authToken;
    }
);


closeSettings.addEventListener(
    "click",
    () => {
        settingsPanel.classList.add("hidden");
    }
);


saveSettings.addEventListener(
    "click",
    () => {

        backendUrl =
            backendUrlInput.value
                .trim()
                .replace(/\/$/, "");

        authToken =
            authTokenInput.value.trim();

        localStorage.setItem(
            "jarvis_backend_url",
            backendUrl
        );

        localStorage.setItem(
            "jarvis_auth_token",
            authToken
        );

        settingsPanel.classList.add("hidden");

        checkBackend();
    }
);


function speak(text) {

    if (!("speechSynthesis" in window)) {
        return;
    }

    window.speechSynthesis.cancel();

    const utterance =
        new SpeechSynthesisUtterance(text);

    utterance.rate = 0.95;
    utterance.pitch = 0.9;

    window.speechSynthesis.speak(
        utterance
    );
}


let recognition = null;

if (
    "SpeechRecognition" in window ||
    "webkitSpeechRecognition" in window
) {

    const SpeechRecognition =
        window.SpeechRecognition ||
        window.webkitSpeechRecognition;

    recognition =
        new SpeechRecognition();

    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => {
        micButton.textContent = "🔴";
        subtitle.textContent =
            "Listening...";
    };

    recognition.onresult = event => {

        const transcript =
            event.results[0][0].transcript;

        messageInput.value =
            transcript;

        sendMessage(transcript);
    };

    recognition.onerror = () => {
        micButton.textContent = "🎙";
        subtitle.textContent =
            "Awaiting your command.";
    };

    recognition.onend = () => {
        micButton.textContent = "🎙";
    };

}


micButton.addEventListener(
    "click",
    () => {

        if (!recognition) {

            addMessage(
                "Voice recognition is not supported by this browser.",
                "jarvis"
            );

            return;
        }

        recognition.start();
    }
);


function loadHistory() {

    messages.innerHTML = "";

    history.forEach(item => {

        if (
            item.role === "user" ||
            item.role === "assistant"
        ) {

            addMessage(
                item.text,
                item.role === "user"
                    ? "user"
                    : "jarvis"
            );

        }

    });
}


loadHistory();
checkBackend();
