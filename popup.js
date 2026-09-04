// popup.js
// This file runs inside the extension popup window.
// It listens for the button click, then asks Chrome to run a
// function INSIDE the current webpage (this is called "script injection").

const analyzeBtn = document.getElementById("analyzeBtn");
const resultsDiv = document.getElementById("results");
const captureBtn = document.getElementById("captureBtn");
const screenshotContainer = document.getElementById("screenshotContainer");
const detectBtn = document.getElementById("detectBtn");
const sensitiveContainer = document.getElementById("sensitiveContainer");
const redactBtn = document.getElementById("redactBtn");
const redactionContainer = document.getElementById("redactionContainer");
const redactScreenshotBtn = document.getElementById("redactScreenshotBtn");
const screenshotRedactionContainer = document.getElementById("screenshotRedactionContainer");
const sendSafeBtn = document.getElementById("sendSafeBtn");
const sendStatusContainer = document.getElementById("sendStatusContainer");
const analyzeSafeBtn = document.getElementById("analyzeSafeBtn");
const analysisContainer = document.getElementById("analysisContainer");

// Step 6 needs to remember the most recent SAFE screenshot (i.e. the
// output of Step 5: either a redacted image, or - if no sensitive fields
// were found - the original screenshot, since there was nothing to hide).
// This is set at the end of the "Redact Screenshot" click handler below,
// and is the ONLY data URL "Send Safe Screenshot" is ever allowed to send.
// The true original screenshot from "Capture Screen" (Step 2) is never
// stored here and is never sent to the server.
let lastSafeScreenshotDataUrl = null;

// Where the local FastAPI server (see server/main.py) is running.
const SERVER_UPLOAD_URL = "http://localhost:8001/upload";
const SERVER_ANALYZE_URL = "http://127.0.0.1:8001/analyze";

analyzeBtn.addEventListener("click", async () => {
  resultsDiv.innerHTML = "<p class='placeholder'>Analyzing...</p>";

  // 1. Find the currently active tab (the webpage the user is looking at)
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.id) {
    resultsDiv.innerHTML = "<p class='placeholder'>Could not find the active tab.</p>";
    return;
  }

  try {
    // 2. Inject and run the "extractPageData" function directly inside the webpage.
    //    chrome.scripting.executeScript lets us run code in the page's context
    //    and get the return value back here in the popup.
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageData, // defined below in this same file
    });

    // executeScript can run on multiple frames, so results is an array.
    // We only care about the main frame's result -> index 0.
    const pageData = injectionResults[0].result;

    renderResults(pageData);
  } catch (err) {
    // This usually happens on special pages like chrome://extensions
    // where Chrome does not allow scripts to run.
    resultsDiv.innerHTML =
      "<p class='placeholder'>Cannot analyze this page (e.g. Chrome system pages are restricted).</p>";
    console.error(err);
  }
});

// -----------------------------------------------------------------
// STEP 2: Capture Screen
// -----------------------------------------------------------------
captureBtn.addEventListener("click", async () => {
  screenshotContainer.innerHTML = "<p class='placeholder'>Capturing...</p>";

  try {
    // chrome.tabs.captureVisibleTab takes a screenshot of the currently
    // visible area of the active tab in the current window.
    // Passing no windowId means "use the current window".
    // It returns a data URL (base64-encoded PNG) we can put straight
    // into an <img> tag's src attribute - no file saving needed.
    //
    // This call is only allowed because it's triggered directly by a
    // user click (a "user gesture"), which is what lets it work under
    // the "activeTab" permission without needing broader permissions.
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });

    renderScreenshot(dataUrl);
  } catch (err) {
    screenshotContainer.innerHTML =
      "<p class='placeholder'>Could not capture this tab (e.g. Chrome system pages are restricted).</p>";
    console.error(err);
  }
});

// Renders the captured screenshot (a data URL string) as an <img> in the popup.
function renderScreenshot(dataUrl) {
  screenshotContainer.innerHTML = `
    <div class="section-title">Screenshot</div>
    <img src="${dataUrl}" alt="Captured tab screenshot" />
  `;
}

// -----------------------------------------------------------------
// STEP 3: Detect Sensitive Data (local, rule-based - nothing leaves
// the browser; no server, no AI model here)
// -----------------------------------------------------------------
detectBtn.addEventListener("click", async () => {
  sensitiveContainer.innerHTML = "<p class='placeholder'>Scanning...</p>";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.id) {
    sensitiveContainer.innerHTML = "<p class='placeholder'>Could not find the active tab.</p>";
    return;
  }

  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: detectSensitiveElements, // defined below in this same file
    });

    const sensitiveData = injectionResults[0].result;
    renderSensitiveResults(sensitiveData);
  } catch (err) {
    sensitiveContainer.innerHTML =
      "<p class='placeholder'>Could not scan this page (e.g. Chrome system pages are restricted).</p>";
    console.error(err);
  }
});

// -----------------------------------------------------------------
// This function is injected into the webpage, same as extractPageData.
// It must be fully self-contained (no outside variables).
//
// GOAL: find form fields that are likely to hold sensitive data, using
// simple, readable rules - not an AI model. For each match, we return
// enough info to later draw a redaction box over it on the screenshot:
// its category, the matched signal, and its on-screen bounding box.
// -----------------------------------------------------------------
function detectSensitiveElements() {
  // Keyword lists per category. All matching is done in lowercase.
  // Feel free to extend these lists later.
  const CATEGORY_KEYWORDS = {
    password: ["password", "pwd", "pass"],
    email: ["email", "e-mail"],
    phone: ["phone", "mobile", "telephone", "contact number", "mob no"],
    aadhaar: ["aadhaar", "aadhar", "uidai"],
    pan: ["pan number", "pan card", "pancard"], // multi-word phrases only, see PAN_WORD_REGEX below
    creditcard: ["card number", "credit card", "debit card", "cvv", "card no"],
    ssn: ["ssn", "social security"],
  };

  // Bare "pan" is too short/ambiguous to safely match with a plain
  // substring check (it would also match "company", "expand", "japan",
  // etc.), so it gets its own word-boundary regex instead.
  const PAN_WORD_REGEX = /\bpan\b/;

  // Gathers every bit of text that describes a field: its attributes
  // plus any associated <label> text.
  function getFieldSignals(el) {
    const parts = [
      el.getAttribute("type"),
      el.getAttribute("name"),
      el.id,
      el.getAttribute("placeholder"),
      el.getAttribute("aria-label"),
      el.getAttribute("autocomplete"),
    ];

    // HTMLInputElement/TextAreaElement expose a `.labels` list of every
    // <label> associated with this field (via for="id" or by wrapping it).
    if (el.labels && el.labels.length > 0) {
      el.labels.forEach((label) => parts.push(label.innerText));
    }

    return parts
      .filter(Boolean) // remove null/undefined/empty
      .join(" ")
      .toLowerCase();
  }

  // Given the combined signal text, figure out which category (if any) matches.
  // The real <input type="..."> is checked first because it's the most reliable signal.
  function classifyField(el, signalText) {
    const type = (el.getAttribute("type") || "").toLowerCase();

    if (type === "password") return { category: "password", matchedOn: "type=password" };
    if (type === "email") return { category: "email", matchedOn: "type=email" };
    if (type === "tel") return { category: "phone", matchedOn: "type=tel" };

    for (const category in CATEGORY_KEYWORDS) {
      const keywords = CATEGORY_KEYWORDS[category];
      for (const keyword of keywords) {
        if (signalText.includes(keyword)) {
          return { category, matchedOn: `keyword:"${keyword}"` };
        }
      }
    }

    // Separate check for bare "PAN" using a word-boundary regex
    // (see comment above PAN_WORD_REGEX for why).
    if (PAN_WORD_REGEX.test(signalText)) {
      return { category: "pan", matchedOn: "keyword:/\\bpan\\b/" };
    }

    return null; // not sensitive
  }

  // Fields worth checking: text-style inputs, textareas, and contenteditable elements.
  const candidateElements = document.querySelectorAll(
    "input, textarea, [contenteditable='true']"
  );

  const findings = [];

  candidateElements.forEach((el, index) => {
    // Skip things that are clearly not meant to hold typed sensitive data.
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (["submit", "button", "checkbox", "radio", "hidden", "file", "image", "reset"].includes(type)) {
      return;
    }

    const signalText = getFieldSignals(el);
    const match = classifyField(el, signalText);
    if (!match) return;

    // getBoundingClientRect gives the element's position/size relative to
    // the current viewport - exactly what's needed to later draw a
    // redaction box on top of a screenshot of that same viewport.
    const rect = el.getBoundingClientRect();

    findings.push({
      index,
      tag: el.tagName.toLowerCase(),
      category: match.category,
      matchedOn: match.matchedOn,
      id: el.id || null,
      name: el.getAttribute("name") || null,
      placeholder: el.getAttribute("placeholder") || null,
      boundingBox: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  });

  return findings;
}

// Renders the list of detected sensitive fields inside the popup.
function renderSensitiveResults(findings) {
  if (!findings || findings.length === 0) {
    sensitiveContainer.innerHTML =
      "<div class='section-title'>Sensitive Data Scan</div>" +
      "<p class='placeholder'>No sensitive fields detected on this page.</p>";
    return;
  }

  let html = `<div class="section-title">Sensitive Data Scan (${findings.length} found)</div>`;

  findings.forEach((item) => {
    const box = item.boundingBox;
    html += `
      <div class="sensitive-item">
        <span class="sensitive-category">${escapeHtml(item.category)}</span>
        <div class="sensitive-detail">
          tag: &lt;${escapeHtml(item.tag)}&gt;<br/>
          matched on: ${escapeHtml(item.matchedOn)}<br/>
          id: ${escapeHtml(item.id || "-")} | name: ${escapeHtml(item.name || "-")}<br/>
          placeholder: ${escapeHtml(item.placeholder || "-")}<br/>
          box: x:${box.x}, y:${box.y}, w:${box.width}, h:${box.height}
        </div>
      </div>
    `;
  });

  sensitiveContainer.innerHTML = html;
}

// -----------------------------------------------------------------
// STEP 4: Redact Sensitive Data (local only - draws black boxes
// directly on the real webpage; nothing is sent anywhere, no AI here)
// -----------------------------------------------------------------
redactBtn.addEventListener("click", async () => {
  redactionContainer.innerHTML = "<p class='placeholder'>Redacting...</p>";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.id) {
    redactionContainer.innerHTML = "<p class='placeholder'>Could not find the active tab.</p>";
    return;
  }

  try {
    // 1. Re-run the Step 3 detector to get a FRESH list of sensitive
    //    fields and their bounding boxes. We detect again (instead of
    //    reusing an older Step 3 result) so the boxes line up correctly
    //    even if the page has changed or scrolled since the last scan.
    const detectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: detectSensitiveElements,
    });
    const findings = detectionResults[0].result;

    if (!findings || findings.length === 0) {
      redactionContainer.innerHTML =
        "<div class='section-title'>Redaction</div>" +
        "<p class='placeholder'>No sensitive fields found, so nothing was redacted.</p>";
      return;
    }

    // 2. Inject a second function that takes those findings and draws a
    //    black overlay box on the actual page for each one. We pass the
    //    findings in via "args" - Chrome copies that data into the page.
    const redactionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: applyRedactionBoxes, // defined below in this same file
      args: [findings],
    });

    const redactedCount = redactionResults[0].result;
    renderRedactionSummary(findings, redactedCount);
  } catch (err) {
    redactionContainer.innerHTML =
      "<p class='placeholder'>Could not redact this page (e.g. Chrome system pages are restricted).</p>";
    console.error(err);
  }
});

// -----------------------------------------------------------------
// This function is injected into the webpage, just like extractPageData
// and detectSensitiveElements. It must be self-contained. Chrome passes
// in "findings" as its argument (matching the "args" array above).
//
// GOAL: cover each sensitive field with an opaque black box, positioned
// using the bounding box we measured in Step 3, WITHOUT breaking the
// rest of the page.
// -----------------------------------------------------------------
function applyRedactionBoxes(findings) {
  // If the button is clicked more than once, remove any boxes drawn by
  // a previous click first, so they don't pile up on top of each other.
  document.querySelectorAll(".ppva-redaction-box").forEach((el) => el.remove());

  let redactedCount = 0;

  findings.forEach((item) => {
    const box = item.boundingBox;
    if (!box || box.width <= 0 || box.height <= 0) return;

    const overlay = document.createElement("div");
    overlay.className = "ppva-redaction-box";
    overlay.setAttribute("data-category", item.category);
    overlay.title = "Redacted: " + item.category; // shows on hover, for demo clarity

    // We use "absolute" positioning anchored to the full document
    // (by adding the current scroll offset), NOT "fixed" positioning.
    // This means the black box scrolls together with the page and
    // stays lined up with the field underneath, even if the user
    // scrolls after redaction is applied.
    overlay.style.position = "absolute";
    overlay.style.left = box.x + window.scrollX + "px";
    overlay.style.top = box.y + window.scrollY + "px";
    overlay.style.width = box.width + "px";
    overlay.style.height = box.height + "px";
    overlay.style.backgroundColor = "#000000";
    overlay.style.opacity = "0.95";
    overlay.style.zIndex = "2147483647"; // max z-index, so it stays on top
    overlay.style.borderRadius = "2px";
    overlay.style.boxSizing = "border-box";

    // pointer-events: none lets clicks/typing pass THROUGH the black box
    // to the real field underneath, so the page stays fully usable -
    // the box is a visual cover, not a functional blocker.
    overlay.style.pointerEvents = "none";

    document.body.appendChild(overlay);
    redactedCount++;
  });

  return redactedCount;
}

// Renders a summary in the popup of which fields were just redacted.
function renderRedactionSummary(findings, redactedCount) {
  let html = `<div class="section-title">Redaction Applied (${redactedCount} area${
    redactedCount === 1 ? "" : "s"
  })</div>`;
  html +=
    "<p class='redaction-note'>Black boxes were drawn directly on the webpage over these fields. " +
    "The page underneath is still fully usable - you can still click and type into the real fields, " +
    "they're just visually hidden.</p>";

  html += "<ul>";
  findings.forEach((item) => {
    html += `<li><strong>${escapeHtml(item.category)}</strong> — id: ${escapeHtml(
      item.id || "-"
    )}, name: ${escapeHtml(item.name || "-")}</li>`;
  });
  html += "</ul>";

  redactionContainer.innerHTML = html;
}

// -----------------------------------------------------------------
// STEP 5: Redact Screenshot (local only - draws black boxes on the
// captured screenshot IMAGE itself, using Canvas. Nothing is sent
// anywhere, no AI/VLM/server here.)
// -----------------------------------------------------------------
redactScreenshotBtn.addEventListener("click", async () => {
  screenshotRedactionContainer.innerHTML = "<p class='placeholder'>Capturing and redacting...</p>";
  lastSafeScreenshotDataUrl = null; // clear any previous result until this run succeeds

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.id) {
    screenshotRedactionContainer.innerHTML = "<p class='placeholder'>Could not find the active tab.</p>";
    return;
  }

  try {
    // 1. Take a fresh screenshot of the tab (same API as Step 2).
    const originalDataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });

    // 2. Re-run the Step 3 detector (REUSED, unchanged) to get fresh
    //    sensitive-field bounding boxes. These boxes are in CSS pixels,
    //    relative to the browser viewport.
    const detectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: detectSensitiveElements,
    });
    const findings = detectionResults[0].result;

    // 3. Get the tab's devicePixelRatio. This is needed because the
    //    screenshot image is captured at DEVICE pixel resolution, while
    //    getBoundingClientRect() (used inside detectSensitiveElements)
    //    measures in CSS pixels. On a normal 1x display these are the
    //    same, but on high-DPI / Retina-style displays (ratio 2, 2.5,
    //    3...) the screenshot is that many times larger than the CSS
    //    pixel coordinates, so we must scale the boxes up to match.
    const scaleResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: getDevicePixelRatio, // defined below in this same file
    });
    const devicePixelRatio = scaleResults[0].result || 1;

    if (!findings || findings.length === 0) {
      screenshotRedactionContainer.innerHTML =
        "<div class='section-title'>Screenshot Redaction</div>" +
        "<p class='placeholder'>No sensitive fields found, so the screenshot was not modified.</p>" +
        `<div class="screenshot-compare-label">Screenshot</div>` +
        `<img src="${originalDataUrl}" alt="Tab screenshot" />`;
      // Nothing sensitive was found, so this screenshot is already "safe"
      // as-is - it's fine for "Send Safe Screenshot" to use it.
      lastSafeScreenshotDataUrl = originalDataUrl;
      return;
    }

    // 4. Draw the redacted version of the screenshot using <canvas>.
    const redactedDataUrl = await buildRedactedScreenshot(
      originalDataUrl,
      findings,
      devicePixelRatio
    );

    renderScreenshotRedactionResults(originalDataUrl, redactedDataUrl, findings);
    // This IS the safe screenshot - sensitive areas are blacked out.
    // This is the only version "Send Safe Screenshot" is allowed to use.
    lastSafeScreenshotDataUrl = redactedDataUrl;
  } catch (err) {
    screenshotRedactionContainer.innerHTML =
      "<p class='placeholder'>Could not redact a screenshot of this page (e.g. Chrome system pages are restricted).</p>";
    console.error(err);
  }
});

// -----------------------------------------------------------------
// This tiny function is injected into the webpage, just like
// extractPageData and detectSensitiveElements. It must be self-contained.
// It simply reports how many device pixels make up one CSS pixel on
// this tab, so we can convert the DOM bounding boxes (CSS pixels) into
// screenshot image coordinates (device pixels).
// -----------------------------------------------------------------
function getDevicePixelRatio() {
  return window.devicePixelRatio || 1;
}

// -----------------------------------------------------------------
// Loads a data URL (like our screenshot) into an <img> element and
// resolves once it's ready to be drawn onto a canvas.
// -----------------------------------------------------------------
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// -----------------------------------------------------------------
// Takes the original screenshot data URL + the detected sensitive
// fields, and returns a NEW data URL where every sensitive area is
// covered with an opaque black rectangle. This all happens locally
// using the Canvas API - the image never leaves the browser.
// -----------------------------------------------------------------
async function buildRedactedScreenshot(originalDataUrl, findings, devicePixelRatio) {
  const image = await loadImage(originalDataUrl);

  // Create an off-screen canvas the same size as the screenshot image
  // (its natural size is already in device pixels, matching the screenshot).
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const ctx = canvas.getContext("2d");

  // Draw the original screenshot as the base layer.
  ctx.drawImage(image, 0, 0);

  // Draw one black rectangle per detected sensitive field, converting
  // each CSS-pixel bounding box into device-pixel image coordinates by
  // multiplying by devicePixelRatio.
  ctx.fillStyle = "#000000";
  findings.forEach((item) => {
    const box = item.boundingBox;
    if (!box || box.width <= 0 || box.height <= 0) return;

    const x = box.x * devicePixelRatio;
    const y = box.y * devicePixelRatio;
    const width = box.width * devicePixelRatio;
    const height = box.height * devicePixelRatio;

    ctx.fillRect(x, y, width, height);
  });

  // Export the canvas back into a PNG data URL, just like
  // chrome.tabs.captureVisibleTab does - so it can go straight into an <img>.
  return canvas.toDataURL("image/png");
}

// Renders the original screenshot and the redacted screenshot side by
// side (stacked) in the popup, plus a short summary of what was covered.
function renderScreenshotRedactionResults(originalDataUrl, redactedDataUrl, findings) {
  let html = `<div class="section-title">Screenshot Redaction (${findings.length} area${
    findings.length === 1 ? "" : "s"
  } covered)</div>`;

  html +=
    "<p class='redaction-note'>The screenshot below was redacted locally using Canvas - " +
    "the image was never uploaded anywhere.</p>";

  html += `<div class="screenshot-compare-label">Original Screenshot</div>`;
  html += `<img src="${originalDataUrl}" alt="Original tab screenshot" />`;

  html += `<div class="screenshot-compare-label redacted">Redacted Screenshot</div>`;
  // NOTE: we do NOT use <a href="${redactedDataUrl}" target="_blank"> here.
  // Opening a data:image/png URL directly in a new tab renders a blank
  // page in some cases, and it also can't carry a heading/subtitle/dark
  // background for a clean demo. Instead, this <img> just gets an id and
  // a "clickable" class; the click handler is attached below in JS (MV3's
  // Content Security Policy doesn't allow inline onclick="..." attributes
  // anyway) and opens our own extension page, "viewer.html".
  html += `<img id="redactedScreenshotImg" class="redacted-screenshot-link" src="${redactedDataUrl}" alt="Redacted tab screenshot" />`;
  html += `<p class="screenshot-hint">Click to open full-size redacted screenshot</p>`;

  screenshotRedactionContainer.innerHTML = html;

  // Attach the click handler AFTER the HTML above is inserted into the
  // page, since the <img> element doesn't exist until then.
  const redactedImg = document.getElementById("redactedScreenshotImg");
  redactedImg.addEventListener("click", () => {
    openRedactedScreenshotInViewerTab(redactedDataUrl);
  });
}

// -----------------------------------------------------------------
// Saves the redacted screenshot into chrome.storage.local (a local,
// on-device storage area private to this extension - not a server, not
// the network), then opens our own "viewer.html" extension page in a
// new tab so the screenshot can be shown full-size for a demo.
// -----------------------------------------------------------------
async function openRedactedScreenshotInViewerTab(redactedDataUrl) {
  try {
    await chrome.storage.local.set({ redactedScreenshot: redactedDataUrl });
    await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
  } catch (err) {
    console.error("Could not open the full-size screenshot viewer:", err);
  }
}

// -----------------------------------------------------------------
// STEP 6: Send Safe Screenshot to the local server.
//
// This sends ONLY `lastSafeScreenshotDataUrl` (set above, right after
// "Redact Screenshot" finishes) to a local FastAPI server running on
// http://localhost:8000. It NEVER has access to the true original,
// un-redacted screenshot - that value simply isn't stored anywhere in
// this popup. No AI/LLM/VLM is involved; the server just receives the
// image file and returns a simple confirmation.
// -----------------------------------------------------------------
sendSafeBtn.addEventListener("click", async () => {
  if (!lastSafeScreenshotDataUrl) {
    sendStatusContainer.innerHTML =
      "<p class='placeholder'>No safe screenshot yet. Click \"Redact Screenshot\" first.</p>";
    return;
  }

  sendStatusContainer.innerHTML = "<p class='placeholder'>Sending redacted screenshot to local server...</p>";

  try {
    // 1. Convert the data URL (base64 PNG text) into an actual binary
    //    Blob. Fetching a data: URL and reading its .blob() is a simple,
    //    dependency-free way to do this conversion in the browser.
    const blob = await (await fetch(lastSafeScreenshotDataUrl)).blob();

    // 2. Package the image as multipart/form-data, the normal way
    //    browsers upload files - FastAPI's UploadFile expects this.
    const formData = new FormData();
    formData.append("file", blob, "redacted_screenshot.png");

    // 3. Send it to our local server. No API key, no third-party
    //    service - just this extension talking to localhost.
    const response = await fetch(SERVER_UPLOAD_URL, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Server responded with status ${response.status}`);
    }

    const result = await response.json();
    renderSendStatus(result);
  } catch (err) {
    sendStatusContainer.innerHTML =
      "<p class='placeholder'>Could not reach the local server. Is it running at " +
      escapeHtml(SERVER_UPLOAD_URL) +
      "? See the README for how to start it.</p>";
    console.error(err);
  }
});

// Renders the server's JSON response in the popup.
function renderSendStatus(result) {
  sendStatusContainer.innerHTML = `
    <div class="section-title">Server Response</div>
    <div class="sensitive-detail">status: ${escapeHtml(String(result.status))}<br/>message: ${escapeHtml(
    String(result.message)
  )}</div>
  `;
}

// -----------------------------------------------------------------
// This function is NOT run in popup.js's normal context.
// Chrome copies this function and executes it inside the webpage's DOM.
// That's why it must be self-contained (it can't use variables from
// outside itself, like resultsDiv).
// -----------------------------------------------------------------
function extractPageData() {
  const title = document.title;

  // Find all <button> elements AND anything with role="button"
  const buttonElements = document.querySelectorAll('button, [role="button"]');
  const buttons = Array.from(buttonElements).map((btn) => {
    return btn.innerText.trim() || btn.value || "(no visible text)";
  });

  // Find all <input> elements
  const inputElements = document.querySelectorAll("input");
  const inputs = Array.from(inputElements).map((input) => {
    return {
      type: input.type || "text",
      name: input.name || "(no name)",
      placeholder: input.placeholder || "(no placeholder)",
    };
  });

  return { title, buttons, inputs };
}

// -----------------------------------------------------------------
// Renders the pageData object as simple HTML inside the popup.
// -----------------------------------------------------------------
function renderResults(pageData) {
  const { title, buttons, inputs } = pageData;

  let html = "";

  html += `<div class="section-title">Page Title</div>`;
  html += `<div>${escapeHtml(title)}</div>`;

  html += `<div class="section-title">Buttons (${buttons.length})</div>`;
  if (buttons.length === 0) {
    html += `<p class="placeholder">No buttons found.</p>`;
  } else {
    html += "<ul>";
    buttons.forEach((text) => {
      html += `<li>${escapeHtml(text)}</li>`;
    });
    html += "</ul>";
  }

  html += `<div class="section-title">Input Fields (${inputs.length})</div>`;
  if (inputs.length === 0) {
    html += `<p class="placeholder">No input fields found.</p>`;
  } else {
    html += "<ul>";
    inputs.forEach((input) => {
      html += `<li>type: ${escapeHtml(input.type)}, name: ${escapeHtml(
        input.name
      )}, placeholder: ${escapeHtml(input.placeholder)}</li>`;
    });
    html += "</ul>";
  }

  resultsDiv.innerHTML = html;
}

// Basic helper to avoid injecting raw HTML from the page into our popup
// (prevents broken layout or unwanted HTML from page text).
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// -----------------------------------------------------------------
// STEP 7A: Analyze Safe Screenshot with Gemini
//
// Only the SAFE screenshot produced by Step 5 is sent.
// The original screenshot is never sent to Gemini.
// -----------------------------------------------------------------
analyzeSafeBtn.addEventListener("click", async () => {
  if (!lastSafeScreenshotDataUrl) {
    analysisContainer.innerHTML =
      "<p class='placeholder'>No safe screenshot yet. Click \"Redact Screenshot\" first.</p>";
    return;
  }

  analysisContainer.innerHTML =
    "<p class='placeholder'>Analyzing safe screenshot with Gemini...</p>";

  try {
    // Convert the already-redacted screenshot data URL into a Blob.
    const blob = await (await fetch(lastSafeScreenshotDataUrl)).blob();

    // Send only the sanitized screenshot.
    const formData = new FormData();
    formData.append("file", blob, "redacted_screenshot.png");

    const response = await fetch(SERVER_ANALYZE_URL, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Server responded with status ${response.status}`);
    }

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || "Gemini analysis failed.");
    }

    renderAnalysisResult(result.analysis);
  } catch (err) {
    analysisContainer.innerHTML =
      "<p class='placeholder'>Could not analyze the safe screenshot. " +
      escapeHtml(err.message) +
      "</p>";

    console.error(err);
  }
});

// Renders Gemini's structured page analysis.
function renderAnalysisResult(analysis) {
  if (!analysis) {
    analysisContainer.innerHTML =
      "<p class='placeholder'>No analysis returned.</p>";
    return;
  }

  let html = `<div class="section-title">Gemini Page Analysis</div>`;

  html += `<p><strong>Page Type:</strong> ${escapeHtml(
    analysis.page_type || "-"
  )}</p>`;

  html += `<div class="section-title">Visible Elements</div>`;

  if (Array.isArray(analysis.visible_elements) &&
      analysis.visible_elements.length > 0) {
    html += "<ul>";

    analysis.visible_elements.forEach((item) => {
      html += `<li>${escapeHtml(String(item))}</li>`;
    });

    html += "</ul>";
  } else {
    html += `<p class="placeholder">None identified.</p>`;
  }

  html += `<div class="section-title">Task-Relevant Text</div>`;

  if (Array.isArray(analysis.task_relevant_text) &&
      analysis.task_relevant_text.length > 0) {
    html += "<ul>";

    analysis.task_relevant_text.forEach((item) => {
      html += `<li>${escapeHtml(String(item))}</li>`;
    });

    html += "</ul>";
  } else {
    html += `<p class="placeholder">None identified.</p>`;
  }

  html += `<div class="section-title">Actionable Elements</div>`;

  if (Array.isArray(analysis.actionable_elements) &&
      analysis.actionable_elements.length > 0) {
    html += "<ul>";

    analysis.actionable_elements.forEach((item) => {
      html += `<li>
        <strong>${escapeHtml(item.type || "other")}</strong>:
        ${escapeHtml(item.label || "-")}
        <br/>
        ${escapeHtml(item.description || "")}
      </li>`;
    });

    html += "</ul>";
  } else {
    html += `<p class="placeholder">None identified.</p>`;
  }

  analysisContainer.innerHTML = html;
}