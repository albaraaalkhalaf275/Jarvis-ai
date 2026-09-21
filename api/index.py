from pathlib import Path

from fastapi.staticfiles import StaticFiles

from backend.app.main import app

web_dir = Path(__file__).resolve().parent.parent / "web"
if web_dir.exists():
    app.mount("/", StaticFiles(directory=web_dir, html=True), name="frontend")
