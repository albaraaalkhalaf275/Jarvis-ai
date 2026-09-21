import os
os.environ["ALLOW_GUEST"] = "true"
os.environ["OPENAI_API_KEY"] = ""

from fastapi.testclient import TestClient
from backend.app.main import app, safe_calculate

client = TestClient(app)

def test_calculator():
    assert safe_calculate("2 + 3 * 4") == "14"

def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True

def test_local_time_response():
    response = client.post("/api/chat", json={"message": "what time is it"})
    assert response.status_code == 200
    assert "It is" in response.json()["reply"]
