"use strict";

const ui = Object.fromEntries(["origin", "count", "fit-count", "clear-fit", "enabled", "start", "reset", "message"].map(id => [id, document.getElementById(id)]));
let tabId;
let state;

async function request(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, tabId, ...extra });
  if (!result?.ok) throw new Error(result?.error || "Расширение недоступно.");
  return result;
}

function render() {
  ui.origin.textContent = state.origin;
  ui.count.textContent = `Правил скрытия: ${state.count}`;
  ui["fit-count"].textContent = `Правил автоподгонки: ${state.fitCount}`;
  ui.enabled.checked = state.enabled;
  ui.enabled.disabled = false;
  ui.start.disabled = false;
  ui.reset.disabled = state.count === 0 && state.fitCount === 0;
  ui["clear-fit"].disabled = state.fitCount === 0;
}

async function act(type, extra) {
  ui.message.textContent = "";
  for (const control of [ui.enabled, ui.start, ui.reset, ui["clear-fit"]]) control.disabled = true;
  try {
    state = await request(type, extra);
    render();
  } catch (error) { ui.message.textContent = error.message; if (state) render(); }
}

ui.enabled.addEventListener("change", () => { void act("TOGGLE", { enabled: ui.enabled.checked }); });
ui.reset.addEventListener("click", () => { void act("RESET"); });
ui["clear-fit"].addEventListener("click", () => { void act("CLEAR_FIT"); });
ui.start.addEventListener("click", async () => {
  ui.start.disabled = true;
  try { await request("START_TAB"); window.close(); }
  catch (error) { ui.message.textContent = error.message; ui.start.disabled = false; }
});

(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Откройте обычную веб-страницу.");
    tabId = tab.id;
    state = await request("STATE");
    render();
  } catch (error) {
    ui.origin.textContent = "Настройка недоступна";
    ui.message.textContent = error.message;
  }
})();
