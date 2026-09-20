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
        addMessage(
            `Connection error: ${error.message}`,
            "jarvis"
        );

        subtitle.textContent =
            "Connection error.";
    }
}
