# Privacy-Preserving Vision Agent (`privacy-vision-agent-extension`) — Steps 1–6

A Chrome extension (Manifest V3) + local FastAPI server that:

1. Reads basic info about the current webpage (title, buttons, inputs).
2. Captures a screenshot of the current tab.
3. Locally detects likely-sensitive form fields (passwords, emails,
   phone numbers, Aadhaar, PAN, credit card, etc.) using simple rules —
   no AI, nothing leaves the browser.
4. Redacts those fields directly on the live webpage with black overlay
   boxes.
5. Redacts those same areas on the *screenshot image* itself (using
   Canvas + `devicePixelRatio` correction), and lets you view the
   redacted screenshot full-size in its own tab.
6. Sends **only** that redacted/sanitized screenshot to a local FastAPI
   server, which saves it into `server/uploads/`.

**Step 7 (Gemini Vision AI) is intentionally NOT implemented yet.** This
project stops at a fully working Step 6. No AI/LLM/VLM calls happen
anywhere in this version.

---

## Final folder structure

```
privacy-vision-agent-extension/
├── manifest.json          # Extension configuration (Manifest V3)
├── popup.html              # Popup UI: all 6 buttons + result containers
├── popup.css                # Styling for the popup
├── popup.js                  # All button logic (Steps 1–6)
├── viewer.html                # Standalone tab: shows full-size redacted screenshot
├── viewer.css                  # Dark, centered styling for the viewer page
├── viewer.js                    # Loads the redacted screenshot from chrome.storage.local
├── test.html                     # Local test form (Name/Email/Phone/Password/Aadhaar/PAN)
├── README.md                      # This file
├── .gitignore                      # Ignores .env, __pycache__, server/uploads/*, etc.
└── server/
    ├── requirements.txt               # fastapi, uvicorn[standard], python-multipart
    ├── main.py                         # FastAPI app: GET / and POST /upload
    ├── .env                             # Reserved for Step 7 (Gemini) — unused right now
    ├── uploads/                          # Where POST /upload saves redacted screenshots
    │   └── .gitkeep                       # Keeps the empty folder in version control
    └── __pycache__/                        # Auto-created by Python when you run the server
```

`server/__pycache__/` is not something you create — Python generates it
automatically the first time you run `uvicorn`. It's safe to ignore or
delete; it'll come back on the next run. It's excluded from Git via
`.gitignore`.

---

## What each extension file does

- **manifest.json** — Declares the popup, and three permissions:
  `activeTab` (access the current tab only when you click the icon),
  `scripting` (inject small functions into the page to read/redact its
  DOM), and `storage` (used by the screenshot viewer to hand off the
  image to `viewer.html`). Also declares `host_permissions` for
  `http://localhost:8000/*` and `http://127.0.0.1:8000/*` so the popup's
  `fetch()` calls can reach the local server.
- **popup.html / popup.css** — The popup window: six buttons (one per
  step below) and a results area under each one.
- **popup.js** — All the logic. Each button has its own `addEventListener`.
  Sensitive-field detection and redaction functions are written so they
  can be injected directly into the webpage via
  `chrome.scripting.executeScript`.
- **viewer.html / viewer.css / viewer.js** — A separate extension page
  (opened in a new tab) that shows the redacted screenshot full-size on
  a dark background, for easy demoing. It reads the image from
  `chrome.storage.local` (put there by `popup.js` right before opening
  the tab).
- **test.html** — A simple local form with Name, Email, Phone, Password,
  Aadhaar, and PAN fields, for testing detection/redaction end to end.

## What each server file does

- **server/main.py** — A FastAPI app with:
  - `GET /` — health check.
  - `POST /upload` — accepts an uploaded image (`multipart/form-data`,
    field name `file`), saves it into `server/uploads/` with a
    timestamped filename, and returns a JSON confirmation. CORS is
    enabled for all origins (`allow_origins=["*"]`) so the extension's
    `chrome-extension://...` origin can call it — fine for local
    development.
- **server/requirements.txt** — `fastapi`, `uvicorn[standard]`,
  `python-multipart` (needed by FastAPI to parse uploaded files).
- **server/.env** — Optional and reserved for a future Step 7. It
  contains no API key in this Steps 1–6 project, and no code in
  `server/main.py` reads it — `server/main.py` never imports
  `os.environ`/`dotenv` or references this file in any way. It exists
  only as a placeholder so the file/folder is already in place if Step 7
  is built later; you can safely delete it without affecting Steps 1–6.
- **server/uploads/** — Where redacted screenshots land after you click
  "Send Safe Screenshot". Starts empty (just a `.gitkeep` placeholder).

---

## Popup UI — buttons and their element IDs

All IDs are consistent across `popup.html` and `popup.js` (this was
double-checked while restoring the project):

| Step | Button label | Button ID | Result container ID |
|---|---|---|---|
| 1 | Analyze Page | `analyzeBtn` | `results` |
| 2 | Capture Screen | `captureBtn` | `screenshotContainer` |
| 3 | Detect Sensitive Data | `detectBtn` | `sensitiveContainer` |
| 4 | Redact Sensitive Data | `redactBtn` | `redactionContainer` |
| 5 | Redact Screenshot | `redactScreenshotBtn` | `screenshotRedactionContainer` |
| 6 | Send Safe Screenshot | `sendSafeBtn` | `sendStatusContainer` |

Every button above has a real `addEventListener("click", ...)` in
`popup.js` — there are no dead/no-op buttons.

---

## How Step 3's local detector works (`detectSensitiveElements`)

Runs entirely inside the webpage via script injection — no network
calls. For every `input`, `textarea`, and `contenteditable` element:

1. Checks the real `type` attribute first: `type="password"` → category
   `password`, `type="email"` → `email`, `type="tel"` → `phone`.
2. Falls back to keyword matching against a combined lowercase string of
   the field's `name`, `id`, `placeholder`, `aria-label`, `autocomplete`,
   and any linked `<label>` text, checking for: `password`, `email`,
   `phone`/`mobile`, `aadhaar`, `pan`, `creditcard`
   (card number/CVV/etc.), `ssn`.
3. Bare `"pan"` uses a word-boundary regex (`/\bpan\b/`) instead of a
   plain substring check, so it won't false-positive on words like
   "company" or "expand".
4. Skips non-text inputs (`checkbox`, `radio`, `submit`, `file`,
   `hidden`, etc.).
5. For each match it records `category`, `matchedOn` (what triggered the
   match), `tag`/`id`/`name`/`placeholder`, and a `boundingBox`
   (`x`, `y`, `width`, `height`) from `element.getBoundingClientRect()`
   — viewport-relative CSS pixels, used later for both DOM and
   screenshot redaction.

## How Step 4's DOM redaction works (`applyRedactionBoxes`)

Re-runs the Step 3 detector for a fresh result, then for each field
creates a `<div>` styled as a solid black rectangle:
- Positioned with `position: absolute` plus the page's current
  `window.scrollX`/`scrollY` added to the bounding box, so it's anchored
  to the *document* and scrolls together with the field.
- `pointer-events: none`, so clicks/typing pass through to the real
  field underneath — the page stays fully usable, only the visual is
  covered.
- Removes any boxes from a previous click first, so repeat clicks don't
  stack duplicates.

## How Step 5's screenshot redaction works (`buildRedactedScreenshot`)

1. Captures a fresh screenshot (`chrome.tabs.captureVisibleTab`).
2. Re-runs `detectSensitiveElements` again for fresh bounding boxes.
3. Injects a tiny `getDevicePixelRatio()` function to read
   `window.devicePixelRatio` from the tab — needed because
   `getBoundingClientRect()` reports **CSS pixels**, while the
   screenshot image is captured at **device pixel** resolution (they
   differ on high-DPI/Retina-style displays).
4. Draws the screenshot onto an off-screen `<canvas>`, then for each
   finding multiplies its bounding box by `devicePixelRatio` and calls
   `ctx.fillRect(...)` with black fill over that area.
5. Exports the canvas with `canvas.toDataURL("image/png")` — this
   redacted data URL becomes `lastSafeScreenshotDataUrl` (the only value
   Step 6 is allowed to send).
6. Shows the **original** and **redacted** screenshots stacked in the
   popup. Clicking the redacted one saves it into
   `chrome.storage.local` and opens `viewer.html` in a new tab (via
   `chrome.tabs.create`) to view it full-size on a dark background.

## How Step 6's send-to-server works

1. `lastSafeScreenshotDataUrl` is set only inside the "Redact Screenshot"
   handler — either to the redacted image, or to the original screenshot
   if no sensitive fields were found (nothing to hide in that case). The
   real original screenshot from "Capture Screen" is **never** stored in
   this variable.
2. Clicking **Send Safe Screenshot**:
   - Converts that data URL into a `Blob` (`fetch(dataUrl).then(r => r.blob())`).
   - Puts it into a `FormData` under the key `"file"`.
   - `fetch("http://localhost:8000/upload", { method: "POST", body: formData })`.
3. `server/main.py`'s `/upload` endpoint saves the file into
   `server/uploads/` with a timestamped name and returns:
   ```json
   { "status": "success", "message": "Sanitized screenshot received", ... }
   ```
4. The popup shows that response under "Server Response".

---

## Installing and running the server (Windows)

Open **Command Prompt** or **PowerShell**, then from the project root
(`privacy-vision-agent-extension`):

```bat
cd server
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

Start the server:

```bat
uvicorn main:app --reload --port 8000
```

You should see output ending in something like:

```
Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
```

Sanity-check it's alive by opening `http://localhost:8000` in a regular
browser tab — you should see:

```json
{"status":"ok","message":"Privacy-Preserving Vision Agent server is running."}
```

Leave this terminal window open and running while you use the extension.
To stop the server later, press `Ctrl+C` in that window.

## Installing and running the server (macOS / Linux)

From the project root:

```bash
cd server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

If your system requires it (e.g. some Linux distros with an
externally-managed Python):

```bash
pip install -r requirements.txt --break-system-packages
```

Start the server the same way:

```bash
uvicorn main:app --reload --port 8000
```

---

## Loading the extension in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `privacy-vision-agent-extension` folder (the one containing
   `manifest.json` — **not** the `server` subfolder).
5. The extension icon appears in your toolbar — pin it if you like.
6. If you make further changes to any file, come back to
   `chrome://extensions` and click the refresh icon on the extension's
   card to reload it.

---

## Step 1 → Step 6 testing checklist

Open `test.html` in a browser tab (double-click the file, or drag it
into a tab) — it has Name, Email, Phone, Password, Aadhaar, and PAN
fields. Then, with the server running (see above):

- [ ] **Step 1 — Analyze Page**: Click the extension icon, then
      **Analyze Page**. You should see the page title, a list of
      buttons, and a list of input fields.
- [ ] **Step 2 — Capture Screen**: Click **Capture Screen**. A
      screenshot of the current tab should appear in the popup.
- [ ] **Step 3 — Detect Sensitive Data**: Click **Detect Sensitive
      Data**. You should see one red card per sensitive field (Email,
      Phone, Password, Aadhaar, PAN), each showing its category, what
      triggered the match, and its bounding box.
- [ ] **Step 4 — Redact Sensitive Data**: Click **Redact Sensitive
      Data**. Solid black boxes should appear directly on `test.html`
      over each sensitive field. Try scrolling the page — the boxes
      should scroll with it and stay aligned. You should still be able
      to click/type into the real fields underneath.
- [ ] **Step 5 — Redact Screenshot**: Click **Redact Screenshot**. The
      popup should show two stacked images: the original screenshot,
      and a redacted version with black rectangles over the sensitive
      fields. Click the redacted image — a new tab should open showing
      it full-size on a dark background with the heading
      "Privacy-Protected Screenshot".
- [ ] **Step 6 — Send Safe Screenshot**: With the server running, click
      **Send Safe Screenshot**. The popup should show a "Server
      Response" block with `status: success` and
      `message: Sanitized screenshot received`. Check
      `server/uploads/` on disk — a new PNG file (named like
      `safe_screenshot_<timestamp>.png`) should now be there, and it
      should visibly be the *redacted* image (open it to confirm the
      sensitive fields are blacked out).

If you click **Send Safe Screenshot** *before* ever clicking **Redact
Screenshot**, the popup should tell you to redact first — this confirms
the original screenshot can never accidentally be sent.

---

## Notes

- Nothing in this project calls any AI/LLM/VLM model, and no data ever
  leaves your machine — the "server" is just `localhost`.
- Step 7 (sending the redacted screenshot to Gemini for a vision
  description) is intentionally not implemented in this restored
  version. The `server/.env` file and the `google-genai` /
  `python-dotenv` dependencies for that step are **not** included here
  on purpose — they'll be added when Step 7 is built.
