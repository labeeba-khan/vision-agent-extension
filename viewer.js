// viewer.js
// This runs on the standalone "viewer.html" extension page (opened in a
// new tab). Its only job is: read the redacted screenshot that the popup
// saved into chrome.storage.local, and show it full-size.
//
// Nothing here talks to a server or the network - chrome.storage.local
// is a local, on-device storage area private to this extension.

const STORAGE_KEY = "redactedScreenshot";

const imageEl = document.getElementById("redactedImage");
const statusEl = document.getElementById("viewerStatus");

async function loadRedactedScreenshot() {
  try {
    // chrome.storage.local.get returns an object like:
    // { redactedScreenshot: "data:image/png;base64,...." }
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const dataUrl = result[STORAGE_KEY];

    if (!dataUrl) {
      statusEl.textContent =
        "No redacted screenshot found. Go back to the extension popup and click \"Redact Screenshot\" again.";
      return;
    }

    imageEl.src = dataUrl;
  } catch (err) {
    statusEl.textContent = "Could not load the redacted screenshot.";
    console.error(err);
  }
}

loadRedactedScreenshot();
