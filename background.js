import "./core.js";

const C = globalThis.CRMCore;
const MENU_ID = "crm-start-customization";
const write = C.serialQueue();
const contentFiles = ["core.js", "selectors.js", "fit.js", "content.js"];

// Call inside the write queue, including reads that may persist a migration.
async function loadStore() {
  const value = (await chrome.storage.local.get(C.STORAGE_KEY))[C.STORAGE_KEY];
  const data = C.readStore(value);
  if (value && value.version !== data.version) await chrome.storage.local.set({ [C.STORAGE_KEY]: data });
  return data;
}

function store() { return write(loadStore); }

async function setup() {
  // Content scripts read rules through messages; websites never receive the entire store.
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID, title: "Start View Customization", contexts: ["all"],
    documentUrlPatterns: ["http://*/*", "https://*/*"]
  });
  await store();
}

chrome.runtime.onInstalled.addListener(() => { setup().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { setup().catch(console.error); });

async function tell(tabId, message, documentId) {
  return chrome.tabs.sendMessage(tabId, message, documentId ? { documentId } : { frameId: 0 });
}

async function start(tabId) {
  const tab = await chrome.tabs.get(tabId);
  C.pageURL(tab.url);
  try { await tell(tabId, { type: "PING" }); }
  catch {
    // Also supports tabs that were already open when the extension was installed.
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: contentFiles });
  }
  const response = await tell(tabId, { type: "START" });
  if (!response?.ok) throw new Error(response?.error || "Не удалось открыть настройку.");
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  start(tab.id).catch(async error => {
    console.warn("CustomViewMode:", error);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" }).catch(() => {});
    await chrome.action.setTitle({ tabId: tab.id, title: "CustomViewMode: " + error.message }).catch(() => {});
  });
});

async function notify(origin, reason) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.filter(tab => {
    try { return C.pageURL(tab.url).origin === origin; } catch { return false; }
  }).map(tab => tell(tab.id, { type: "SITE_CHANGED", reason })));
}

function popupSender(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html");
}

function contentSender(sender) {
  return sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id) &&
    sender.frameId === 0 && typeof sender.documentId === "string";
}

async function contentURL(sender, requested) {
  if (!contentSender(sender)) throw new Error("Недопустимый источник запроса.");
  const current = C.pageURL((await chrome.tabs.get(sender.tab.id)).url);
  const url = C.pageURL(requested);
  if (url.href !== current.href) throw new Error("Адрес страницы изменился. Запустите настройку снова.");
  if (C.pageURL(sender.url).origin !== url.origin) throw new Error("Источник страницы изменился.");
  return url.href;
}

async function replaceCSS(message, sender) {
  if (!contentSender(sender)) throw new Error("Недопустимый источник запроса.");
  const oldCSS = C.compileCSS(message.previous, message.token, message.layer);
  const newCSS = C.compileCSS(message.selectors, message.token, message.layer);
  if (oldCSS === newCSS) return;
  const target = { tabId: sender.tab.id, documentIds: [sender.documentId] };
  if (newCSS) await chrome.scripting.insertCSS({ target, css: newCSS, origin: "USER" });
  try {
    if (oldCSS) await chrome.scripting.removeCSS({ target, css: oldCSS, origin: "USER" });
  } catch (error) {
    if (newCSS) await chrome.scripting.removeCSS({ target, css: newCSS, origin: "USER" }).catch(() => {});
    throw error;
  }
}

async function handle(message, sender) {
  if (!message || typeof message.type !== "string" || sender.id !== chrome.runtime.id) throw new Error("Недопустимый запрос.");
  if (message.type === "STYLE") {
    await replaceCSS(message, sender);
    return {};
  }
  if (message.type === "GET_RULES") {
    const url = await contentURL(sender, message.url);
    const data = await store();
    return { selectors: C.applicableSelectors(data, url), fit: C.applicableFit(data, url), ...C.siteState(data, url) };
  }
  if (message.type === "SAVE") {
    return write(async () => {
      const url = await contentURL(sender, message.url);
      const scope = C.makeScope(url, message.scope?.mode, message.scope?.path);
      const selectors = C.validateSelectors(message.selectors ?? []);
      const fit = message.fit === undefined ? undefined : C.validateFit(message.fit);
      if (!selectors.length && !fit) throw new Error("Сначала выберите элемент.");
      if (selectors.length > 500) throw new Error("Максимум 500 правил за один сеанс.");
      const next = C.addGroup(await loadStore(), scope, selectors, crypto.randomUUID(), fit);
      await chrome.storage.local.set({ [C.STORAGE_KEY]: next });
      // Do not wait for content scripts: the saving tab may itself be waiting on this response.
      void notify(scope.origin, "saved").catch(console.error);
      return C.siteState(next, url);
    });
  }
  if (!popupSender(sender)) throw new Error("Эта команда доступна только из окна расширения.");
  if (!Number.isInteger(message.tabId)) throw new Error("Вкладка не найдена.");
  const tab = await chrome.tabs.get(message.tabId);
  const url = C.pageURL(tab.url);
  if (message.type === "STATE") return C.siteState(await store(), url.href);
  if (message.type === "START_TAB") {
    await start(tab.id);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    return {};
  }
  if (["TOGGLE", "RESET", "CLEAR_FIT"].includes(message.type)) {
    const state = await write(async () => {
      const next = structuredClone(await loadStore());
      if (message.type === "TOGGLE") {
        if (typeof message.enabled !== "boolean") throw new Error("Некорректное состояние сайта.");
        next.sites[url.origin] = { enabled: message.enabled };
      } else if (message.type === "CLEAR_FIT") {
        for (const group of next.groups) {
          if (group.scope.origin === url.origin) delete group.fit;
        }
        next.groups = next.groups.filter(group => group.selectors.length || group.fit);
      } else {
        next.groups = next.groups.filter(group => group.scope.origin !== url.origin);
        delete next.sites[url.origin];
      }
      await chrome.storage.local.set({ [C.STORAGE_KEY]: next });
      return C.siteState(next, url.href);
    });
    // Tab notifications request GET_RULES, whose migration-safe read uses this queue too.
    // Release the write queue before waiting for those replies.
    await notify(url.origin, message.type.toLowerCase());
    return state;
  }
  throw new Error("Неизвестная команда.");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(result => sendResponse({ ok: true, ...result }),
    error => sendResponse({ ok: false, error: error.message || "Ошибка расширения." }));
  return true;
});

function navigation(details) {
  if (details.frameId !== 0) return;
  void tell(details.tabId, { type: "NAVIGATION" }, details.documentId).catch(() => {});
}
chrome.webNavigation.onHistoryStateUpdated.addListener(navigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(navigation);
