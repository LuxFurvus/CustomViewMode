const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

function workerHarness() {
  let handler;
  let menuHandler;
  let data;
  let failWrite = false;
  const css = new Set();
  const notices = [];
  const tab = { id: 7, url: "https://example.com/articles/1" };
  const chrome = {
    runtime: {
      id: "extension", getURL: file => "chrome-extension://extension/" + file,
      onMessage: { addListener: fn => { handler = fn; } },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} }
    },
    storage: { local: {
      get: async () => ({ customViewMode: data }),
      set: async value => {
        await new Promise(resolve => setTimeout(resolve, 2));
        if (failWrite) throw new Error("Storage quota exceeded");
        data = structuredClone(value.customViewMode);
      }
    } },
    tabs: {
      get: async () => tab, query: async () => [tab],
      sendMessage: async (id, message) => { notices.push(message); return { ok: true }; }
    },
    scripting: {
      insertCSS: async ({ css: text }) => { css.add(text); },
      removeCSS: async ({ css: text }) => { css.delete(text); }
    },
    contextMenus: { onClicked: { addListener: fn => { menuHandler = fn; } } },
    webNavigation: { onHistoryStateUpdated: { addListener() {} }, onReferenceFragmentUpdated: { addListener() {} } }
  };
  const context = vm.createContext({ chrome, console, URL, structuredClone, crypto: webcrypto, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../core.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8").replace('import "./core.js";', ""), context);
  const content = { id: "extension", tab: { id: 7 }, frameId: 0, documentId: "doc-1", url: tab.url };
  const popup = { id: "extension", url: "chrome-extension://extension/popup.html" };
  return {
    call: (message, sender = content) => new Promise(resolve => handler(message, sender, resolve)),
    content, popup, css, notices, get data() { return data; },
    fail(value) { failWrite = value; }, tab,
    clickMenu: () => menuHandler({ menuItemId: "crm-start-customization" }, tab)
  };
}

test("worker serializes simultaneous saves from tabs and deduplicates rules", async () => {
  const worker = workerHarness();
  const save = selectors => worker.call({ type: "SAVE", url: worker.tab.url, scope: { mode: "site" }, selectors });
  const results = await Promise.all([save(["#first"]), save(["#second"]), save(["#first"])]);
  assert.equal(results.every(result => result.ok), true);
  assert.deepEqual(Array.from(worker.data.groups[0].selectors), ["#first", "#second"]);
});

test("failed save leaves previous rules untouched and a retry succeeds", async () => {
  const worker = workerHarness();
  const save = selectors => worker.call({ type: "SAVE", url: worker.tab.url, scope: { mode: "site" }, selectors });
  await save(["#existing"]);
  worker.fail(true);
  assert.equal((await save(["#new"])).ok, false);
  assert.deepEqual(Array.from(worker.data.groups[0].selectors), ["#existing"]);
  worker.fail(false);
  assert.equal((await save(["#new"])).ok, true);
});

test("popup toggle and reset notify tabs and preserve/remove the correct data", async () => {
  const worker = workerHarness();
  await worker.call({ type: "SAVE", url: worker.tab.url, scope: { mode: "site" }, selectors: [".ad"] });
  const disabled = await worker.call({ type: "TOGGLE", tabId: 7, enabled: false }, worker.popup);
  assert.equal(disabled.enabled, false);
  assert.equal(worker.data.groups.length, 1);
  assert.deepEqual(Array.from((await worker.call({ type: "GET_RULES", url: worker.tab.url })).selectors), []);
  assert.equal(worker.notices.at(-1).reason, "toggle");
  const reset = await worker.call({ type: "RESET", tabId: 7 }, worker.popup);
  assert.equal(reset.count, 0);
  assert.equal(worker.data.groups.length, 0);
});

test("worker rejects foreign sources, iframe requests, stale URLs and content-only admin commands", async () => {
  const worker = workerHarness();
  const get = { type: "GET_RULES", url: worker.tab.url };
  for (const sender of [{ ...worker.content, id: "other" }, { ...worker.content, frameId: 1 }, { ...worker.content, url: "https://other.com/" }]) {
    assert.equal((await worker.call(get, sender)).ok, false);
  }
  assert.equal((await worker.call({ ...get, url: "https://example.com/articles/2" })).ok, false);
  assert.equal((await worker.call({ type: "RESET", tabId: 7 })).ok, false);
});

test("preview and saved CSS can be removed independently, including after worker restart", async () => {
  const worker = workerHarness();
  const base = { type: "STYLE", token: "document-1", previous: [], selectors: ["#ad"] };
  await worker.call({ ...base, layer: "saved" });
  await worker.call({ ...base, layer: "preview" });
  assert.equal(worker.css.size, 2);
  await worker.call({ ...base, layer: "preview", previous: ["#ad"], selectors: [] });
  assert.equal(worker.css.size, 1);
  assert.match([...worker.css][0], / saved /);
});

test("context-menu command sends START to the current tab", async () => {
  const worker = workerHarness();
  worker.clickMenu();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(worker.notices.at(-1).type, "START");
});
