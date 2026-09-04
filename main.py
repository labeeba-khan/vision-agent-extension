# server/main.py
#
# Steps 1-6: a very small local server whose job is:
#   1. Accept an uploaded image file at POST /upload
#   2. Save it into server/uploads/ (so you can open it and confirm
#      it really is the redacted/safe screenshot)
#   3. Reply with a simple JSON confirmation
#
# Step 7 (in progress): read GEMINI_API_KEY from server/.env so a later
# task can add a POST /analyze endpoint that sends the sanitized
# screenshot to Gemini. No Gemini calls happen yet in this file - this
# step only loads and confirms the key is present.

import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types

# -----------------------------------------------------------------
# Load environment variables from server/.env (if present) into this
# process. This reads the file locally on the server only - the key
# never touches the browser extension or any client-side code.
#
# We pass an explicit dotenv_path here (the .env file sitting right
# next to this main.py) instead of calling load_dotenv() with no
# arguments. With no argument, python-dotenv only searches upward from
# the current WORKING directory the process was started in - if
# uvicorn is ever launched from a different folder (or restarted by
# --reload from a different cwd), it can silently fail to find the
# file. Anchoring to this file's own location makes it work no matter
# where the command is run from.
# -----------------------------------------------------------------
ENV_PATH = Path(__file__).parent / ".env"
SERVER_DIR = ENV_PATH.parent
load_dotenv(dotenv_path=ENV_PATH)
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

# Current (as of writing), GA, stable, multimodal Gemini model. Kept as
# one named constant so it's a one-line change if Google updates things.
GEMINI_MODEL = "gemini-3.5-flash"

# -----------------------------------------------------------------
# Step 7A: the fixed prompt sent to Gemini for POST /analyze. The
# uploaded image is ALWAYS treated as an already-sanitized/redacted
# screenshot (this endpoint never receives, and never sends, an
# original/unredacted screenshot, DOM data, or any other page data -
# only this text prompt and the one uploaded image go to Gemini).
# -----------------------------------------------------------------
ANALYZE_PROMPT = """You are a visual page-understanding component for a privacy-preserving browser agent.

Analyze this already-sanitized screenshot.

Identify:
- the likely page type,
- important visible UI elements,
- visible non-sensitive task-relevant text,
- obvious actionable controls such as buttons, links, or input fields.

Do not attempt to recover, infer, reconstruct, or guess any redacted sensitive information.

Return ONLY valid JSON with this structure:

{
  "page_type": "...",
  "visible_elements": ["..."],
  "task_relevant_text": ["..."],
  "actionable_elements": [
    {
      "type": "button|link|input|other",
      "label": "...",
      "description": "..."
    }
  ]
}

Do not include Markdown code fences. Return only the raw JSON object."""

app = FastAPI(title="Privacy-Preserving Vision Agent - Local Server (Step 6)")

# -----------------------------------------------------------------
# CORS (Cross-Origin Resource Sharing)
# -----------------------------------------------------------------
# The Chrome extension's popup runs at an origin like
# "chrome-extension://<extension-id>", which is different from
# "http://localhost:8000". Browsers block cross-origin fetch() calls
# by default unless the SERVER explicitly allows them via CORS headers.
#
# For local development we allow all origins ("*") so this works no
# matter what your extension's generated ID is. This is fine for a
# hackathon prototype running only on your own machine; a real
# deployment would restrict this to specific origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------------------------------------------
# Where uploaded (already-redacted) screenshots get saved.
# This folder is created automatically the first time the server
# starts, so you don't need to create it by hand.
# -----------------------------------------------------------------
UPLOAD_DIR = Path(__file__).parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)


@app.get("/")
def read_root():
    """Simple health-check endpoint - open http://localhost:8000 in a
    browser to confirm the server is running.

    TEMPORARY DIAGNOSTICS (Task 3 debugging - will be removed once the
    .env loading issue is confirmed fixed): these fields help pinpoint
    why GEMINI_API_KEY isn't being detected, WITHOUT ever reading or
    exposing the key's actual value:
      - debug_main_py_path: the absolute path of THIS main.py file, as
        Python sees it right now. If this doesn't match the file you
        just edited, uvicorn is running a different copy entirely (a
        duplicate project folder, an old venv, a leftover install,
        etc.) and no edit to "your" main.py will ever take effect.
      - debug_env_path: the exact path Python is looking for .env at.
      - debug_env_path_exists: whether a file exists at exactly that
        path (Path.exists() checks the literal name - if your file is
        actually named ".env.txt" instead of ".env", a common Windows
        Notepad/Explorer gotcha where file extensions are hidden by
        default, this will be False even though "something" is there).
      - debug_files_in_server_dir: the plain filenames (not contents)
        of everything in this server/ folder, so you can see the real
        name of your env file at a glance.
      - debug_gemini_key_length: the LENGTH of the value found for
        GEMINI_API_KEY (0 if not found). This reveals nothing about
        the key's characters, only whether *something* (and roughly
        how much) was loaded.
    """
    return {
        "status": "ok",
        "message": "Privacy-Preserving Vision Agent server is running.",
        "gemini_key_configured": bool(GEMINI_API_KEY),
        "debug_main_py_path": os.path.abspath(__file__),
        "debug_env_path": str(ENV_PATH),
        "debug_env_path_exists": ENV_PATH.exists(),
        "debug_files_in_server_dir": sorted(p.name for p in SERVER_DIR.iterdir()),
        "debug_gemini_key_length": len(GEMINI_API_KEY) if GEMINI_API_KEY else 0,
    }


@app.get("/test-gemini")
def test_gemini():
    """
    TEMPORARY diagnostic endpoint (Task 4). Makes ONE minimal,
    authenticated request to the real Gemini API using GEMINI_API_KEY,
    to confirm the key actually works against Google's servers before
    any real image-analysis code is built.

    This sends a tiny text-only prompt - no image, no page data, no
    sensitive information of any kind goes to Gemini here.

    Returns only success/failure, an error status (if it failed), and a
    short error message (if it failed). The API key itself is NEVER
    included in the response, and it is never printed/logged either.
    """
    if not GEMINI_API_KEY:
        return {
            "success": False,
            "error_status": "NO_KEY",
            "error_message": "GEMINI_API_KEY is not set (see server/.env).",
        }

    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents="Reply with exactly one word: OK",
            config=genai_types.GenerateContentConfig(max_output_tokens=10),
        )
        return {
            "success": True,
            "error_status": None,
            "error_message": None,
        }
    except genai_errors.APIError as e:
        # Covers auth failures (bad/revoked key), quota errors, and
        # other errors the Gemini API itself reports back.
        return {
            "success": False,
            "error_status": getattr(e, "code", None) or getattr(e, "status", None),
            "error_message": (getattr(e, "message", None) or str(e))[:300],
        }
    except Exception as e:
        # Covers everything else (e.g. no internet connection).
        return {
            "success": False,
            "error_status": type(e).__name__,
            "error_message": str(e)[:300],
        }


@app.post("/upload")
async def upload_sanitized_screenshot(file: UploadFile = File(...)):
    """
    Receives the SANITIZED/REDACTED screenshot from the extension and
    saves it into server/uploads/.

    The extension is responsible for only ever sending the redacted
    image (never the original) - this endpoint doesn't know or care
    about that distinction, it just accepts whatever image file it's
    given, saves it, and confirms receipt.
    """
    # Read the uploaded file's bytes into memory.
    contents = await file.read()

    # Build a safe, unique filename (using a timestamp) so repeated
    # uploads don't silently overwrite each other.
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    original_suffix = Path(file.filename or "screenshot.png").suffix or ".png"
    safe_filename = f"safe_screenshot_{timestamp}{original_suffix}"
    destination_path = UPLOAD_DIR / safe_filename

    with open(destination_path, "wb") as saved_file:
        saved_file.write(contents)

    return {
        "status": "success",
        "message": "Sanitized screenshot received",
        "filename": safe_filename,
        "content_type": file.content_type,
        "size_bytes": len(contents),
        "saved_path": str(destination_path),
    }


@app.post("/analyze")
async def analyze_sanitized_screenshot(file: UploadFile = File(...)):
    """
    Step 7A: SANITIZED SCREENSHOT -> Gemini Vision -> structured JSON.

    Like /upload, this endpoint trusts the caller to only ever send the
    already-redacted/sanitized screenshot (the extension feeds this from
    the same `lastSafeScreenshotDataUrl` value that /upload uses - see
    popup.js). This endpoint never receives and never forwards anything
    else: no original screenshot, no DOM/page HTML, no form values, no
    cookies, no local storage. The ONLY things sent to Gemini are this
    one uploaded image and the fixed ANALYZE_PROMPT text above.

    Uses the exact same genai.Client(api_key=GEMINI_API_KEY) / GEMINI_MODEL
    setup already used by /test-gemini - no second Gemini configuration.
    """
    if not GEMINI_API_KEY:
        return {
            "success": False,
            "error": "GEMINI_API_KEY is not set (see server/.env).",
        }

    image_bytes = await file.read()
    if not image_bytes:
        return {
            "success": False,
            "error": "No image data received.",
        }

    mime_type = file.content_type or "image/png"

    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[
                ANALYZE_PROMPT,
                genai_types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
            ],
            config=genai_types.GenerateContentConfig(
                max_output_tokens=1024,
                response_mime_type="application/json",
            ),
        )
        raw_text = (response.text or "").strip()
    except genai_errors.APIError as e:
        # Covers auth failures, quota errors, and other errors the
        # Gemini API itself reports back. Never includes the API key.
        return {
            "success": False,
            "error": (getattr(e, "message", None) or str(e))[:300],
        }
    except Exception as e:
        # Covers everything else (e.g. no internet connection).
        return {
            "success": False,
            "error": str(e)[:300],
        }

    # Defensive cleanup only: response_mime_type="application/json" plus
    # the prompt already ask Gemini for raw JSON with no Markdown fences,
    # but if it adds them anyway, strip them before parsing rather than
    # failing outright.
    cleaned = raw_text
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").strip()
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()

    try:
        analysis = json.loads(cleaned)
    except (json.JSONDecodeError, TypeError):
        return {
            "success": False,
            "error": "Gemini did not return valid JSON.",
        }

    return {
        "success": True,
        "analysis": analysis,
    }
