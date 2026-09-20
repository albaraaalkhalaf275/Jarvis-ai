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

    // Capture previous conversation before adding the new message.
    // This prevents the current message from being sent twice.
    const historyForRequest = history.slice(-20);

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
                    history: historyForRequest
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.detail || "Request failed"
            );
        }

        const reply =
            data.reply || "No response received.";

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
