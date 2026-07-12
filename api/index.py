"""Vercel serverless entry point: every /api/* request is rewritten here
(see vercel.json) and handled by the FastAPI app, which sees the original
request path."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402, F401
