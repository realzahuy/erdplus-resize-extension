const DEFAULT_SETTINGS = {
  fontSize: 11,
  autoFit: true,
  showGrid: true,
  horizontalPadding: 12,
  verticalPadding: 8,
  enabled: false
};

const $ = (id) => document.getElementById(id);

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function readForm() {
  return {
    fontSize: clamp($("fontSize").value, 10, 24, DEFAULT_SETTINGS.fontSize),
    autoFit: $("autoFit").checked,
    showGrid: $("showGrid").checked,
    horizontalPadding: clamp($("horizontalPadding").value, 0, 50, DEFAULT_SETTINGS.horizontalPadding),
    verticalPadding: clamp($("verticalPadding").value, 0, 50, DEFAULT_SETTINGS.verticalPadding)
  };
}

function writeForm(settings) {
  $("fontSize").value = settings.fontSize;
  $("autoFit").checked = settings.autoFit;
  $("showGrid").checked = settings.showGrid;
  $("horizontalPadding").value = settings.horizontalPadding;
  $("verticalPadding").value = settings.verticalPadding;
}

function showStatus(message, isError = false) {
  const status = $("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function sendToCurrentTab(message, retryAfterInjection = false) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || typeof tab.id !== "number") {
        reject(new Error("No active tab."));
        return;
      }

      chrome.tabs.sendMessage(tab.id, message, async () => {
        const error = chrome.runtime.lastError;
        if (!error) {
          resolve();
          return;
        }

        if (!retryAfterInjection) {
          try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
            sendToSpecificTab(tab.id, message).then(resolve, reject);
          } catch (injectionError) {
            reject(injectionError);
          }
          return;
        }

        reject(error);
      });
    });
  });
}

function sendToSpecificTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(error);
      else resolve();
    });
  });
}

function loadSavedSettings() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    const savedSettings = { ...DEFAULT_SETTINGS, ...settings };
    // A setting is considered user-selected only after Apply has been pressed.
    if (settings.enabled !== true) savedSettings.fontSize = DEFAULT_SETTINGS.fontSize;
    writeForm(savedSettings);
  });
}

$("apply").addEventListener("click", () => {
  const settings = { ...readForm(), enabled: true };
  writeForm(settings);
  chrome.storage.sync.set(settings, () => {
    sendToCurrentTab({ type: "APPLY_SETTINGS", settings })
      .then(() => showStatus("Applied."))
      .catch(() => showStatus("Open ERDPlus and try again.", true));
  });
});

$("reset").addEventListener("click", () => {
  const resetSettings = { ...DEFAULT_SETTINGS, enabled: false };
  writeForm(resetSettings);
  chrome.storage.sync.set(resetSettings, () => {
    sendToCurrentTab({ type: "RESET_SETTINGS", settings: resetSettings })
      .then(() => showStatus("Reset complete."))
      .catch(() => showStatus("Open ERDPlus and try again.", true));
  });
});

loadSavedSettings();
