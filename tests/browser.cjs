/* Real unpacked-extension tests. Uses a temporary Chromium profile, never the user's profile. */
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const results = path.join(root, "test-results");
fs.mkdirSync(results, { recursive: true });
const fixture = fs.readFileSync(path.join(__dirname, "fixture.html"));
const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(fixture);
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "custom-read-mode-test-"));
let context;
let passed = 0;

async function check(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const launch = () => chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, viewport: { width: 1120, height: 900 },
    ...(process.env.CRM_CHROMIUM_PATH ? { executablePath: process.env.CRM_CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  context = await launch();
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  let page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin + "/articles/one?q=1");
  const visible = (selector, expected = true, target = page) => target.waitForFunction(
    ({ selector, expected }) => {
      const node = document.querySelector(selector);
      return !!node && (getComputedStyle(node).display !== "none") === expected;
    }, { selector, expected }
  );
  const panel = () => page.locator("[data-crm-root]");
  async function start(target = page) {
    const result = await worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      return chrome.tabs.sendMessage(tab.id, { type: "START" }, { frameId: 0 });
    }, target.url());
    assert.equal(result.ok, true, result.error);
    await target.locator("[data-crm-root]").waitFor();
  }
  async function popupCommand(type, extra = {}, target = page) {
    const popup = await context.newPage();
    await target.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const result = await popup.evaluate(async ({ type, extra, url }) => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      return chrome.runtime.sendMessage({ type, tabId: tab.id, ...extra });
    }, { type, extra, url: target.url() });
    await popup.close();
    assert.equal(result.ok, true, result.error);
    return result;
  }
  async function reset() { await popupCommand("RESET"); }

  await check("hover, isolated draggable panel, single selection, undo, cancel", async () => {
    await start();
    await page.locator("#sidebar").hover();
    await panel().locator(".outline").waitFor({ state: "visible" });
    await page.locator("#sidebar").click();
    await visible("#sidebar", false);
    await page.keyboard.press("Control+z");
    await visible("#sidebar");
    const header = panel().locator(".header");
    const box = await header.boundingBox();
    await page.mouse.move(box.x + 70, box.y + 15);
    await page.mouse.down();
    await page.mouse.move(90, 100, { steps: 8 });
    await page.mouse.up();
    assert.ok((await panel().locator(".panel").boundingBox()).x < 100);
    await page.setViewportSize({ width: 600, height: 600 });
    const moved = await panel().locator(".panel").boundingBox();
    assert.ok(moved.x >= 0 && moved.y >= 0);
    await page.setViewportSize({ width: 1120, height: 900 });
    await panel().getByRole("button", { name: "Отклонить", exact: true }).click();
    await panel().waitFor({ state: "detached" });
    await visible("#sidebar");
  });

  await check("selection blocks links, forms and existing window click handlers", async () => {
    await page.reload();
    await start();
    const url = page.url();
    await page.locator("#promo-link").click();
    await visible("#promo-link", false);
    assert.equal(page.url(), url);
    assert.equal(await page.evaluate(() => window.pageClicks), 0);
    await page.locator("#submit").click();
    assert.equal(await page.evaluate(() => window.submits), 0);
    await page.keyboard.press("Escape");
    await visible("#promo-link");
    await visible("#submit");
    assert.equal((await popupCommand("STATE")).count, 0);
  });

  await check("page scope persists, respects query and beats inline important CSS", async () => {
    await start();
    await page.locator("#sidebar").click();
    await panel().locator("#scope").selectOption("page");
    await panel().getByRole("button", { name: "Принять", exact: true }).click();
    await panel().waitFor({ state: "detached" });
    await page.reload();
    await visible("#sidebar", false);
    await page.goto(origin + "/articles/one?q=2");
    await visible("#sidebar");
    await page.goto(origin + "/articles/one?q=1");
    await visible("#sidebar", false);
    await start();
    await page.locator("#page-footer").click();
    await page.keyboard.press("Escape");
    await visible("#sidebar", false);
    await visible("#page-footer");
    await reset();
    await visible("#sidebar");
  });

  await check("group preview, undo and dynamic elements follow saved section rules", async () => {
    await start();
    await page.locator(".story-card").nth(1).click();
    await visible(".story-card:nth-child(2)", false);
    await visible(".story-card:nth-child(1)");
    await panel().locator(".all").check();
    await visible(".story-card:nth-child(1)", false);
    await panel().locator(".all").uncheck();
    await visible(".story-card:nth-child(1)");
    await panel().locator(".all").check();
    await page.keyboard.press("Control+z");
    await visible(".story-card:nth-child(2)");
    await page.locator(".story-card").nth(0).click();
    await panel().locator(".all").check();
    await panel().locator("#scope").selectOption("section");
    assert.equal(await panel().locator("#section").inputValue(), "/articles");
    await panel().getByRole("button", { name: "Принять", exact: true }).click();
    await panel().waitFor({ state: "detached" });
    await page.evaluate(() => {
      const card = document.createElement("article"); card.className = "story-card"; card.id = "dynamic-card";
      card.textContent = "Dynamic"; document.querySelector("#cards").append(card);
    });
    await visible("#dynamic-card", false);
    await page.goto(origin + "/articles/two");
    await visible(".story-card", false);
    await page.goto(origin + "/articles-old/two");
    await visible(".story-card");
  });

  await check("SPA transitions update rules and discard unsaved changes", async () => {
    await page.evaluate(() => history.pushState({}, "", "/articles/three"));
    await visible(".story-card", false);
    await start();
    await page.locator("#page-footer").click();
    await visible("#page-footer", false);
    await page.evaluate(() => history.pushState({}, "", "/other"));
    await panel().waitFor({ state: "detached" });
    await visible("#page-footer");
    await visible(".story-card");
    await page.goBack();
    await visible(".story-card", false);
    await reset();
  });

  await check("CSS escaping, positional warning and iframe outer-element selection", async () => {
    await start();
    await page.locator('[id="promo:banner"]').click();
    await visible('[id="promo:banner"]', false);
    await page.locator(".plain-list > div").nth(1).click();
    await panel().locator(".warning").waitFor({ state: "visible" });
    await panel().locator(".all").check();
    await visible(".plain-list > div", false);
    await page.locator("#test-frame").scrollIntoViewIfNeeded();
    const frame = await page.locator("#test-frame").boundingBox();
    await page.mouse.click(frame.x + 20, frame.y + 20);
    await visible("#test-frame", false);
    await page.keyboard.press("Escape");
    await visible("#test-frame");
    await visible('[id="promo:banner"]');
  });

  await check("failed storage write keeps the editor and old rules intact; retry succeeds", async () => {
    await start();
    await page.locator("#page-footer").click();
    await worker.evaluate(() => {
      globalThis.originalStorageSet = chrome.storage.local.set;
      chrome.storage.local.set = async () => { throw new Error("Test storage failure"); };
    });
    try {
      await panel().getByRole("button", { name: "Принять", exact: true }).click();
      await panel().locator(".error").filter({ hasText: "Test storage failure" }).waitFor();
      await visible("#page-footer", false);
      assert.equal((await popupCommand("STATE")).count, 0);
    } finally {
      await worker.evaluate(() => { chrome.storage.local.set = globalThis.originalStorageSet; });
    }
    await panel().getByRole("button", { name: "Принять", exact: true }).click();
    await panel().waitFor({ state: "detached" });
    assert.equal((await popupCommand("STATE")).count, 1);
    await reset();
    await visible("#page-footer");
  });

  await check("site rules update every tab; worker suspension does not lose CSS ownership", async () => {
    await start();
    await page.locator("#sidebar").click();
    await panel().getByRole("button", { name: "Принять", exact: true }).click();
    await panel().waitFor({ state: "detached" });
    const second = await context.newPage();
    await second.goto(origin + "/different");
    await visible("#sidebar", false, second);
    // Stop the actual extension worker, then let a popup message wake a fresh instance.
    const cdp = await context.newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await popupCommand("TOGGLE", { enabled: false });
    worker = context.serviceWorkers().find(item => item.url().includes(extensionId)) || await context.waitForEvent("serviceworker");
    await visible("#sidebar");
    await visible("#sidebar", true, second);
    assert.equal((await popupCommand("STATE")).count, 1);
    await popupCommand("TOGGLE", { enabled: true });
    await visible("#sidebar", false);
    await visible("#sidebar", false, second);
    await second.close();
  });

  await check("rules survive full browser restart", async () => {
    await context.close();
    context = await launch();
    worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    page = await context.newPage();
    await page.goto(origin + "/restarted");
    await visible("#sidebar", false);
    await reset();
    await visible("#sidebar");
    await page.locator("#submit").click();
    assert.equal(await page.evaluate(() => window.submits), 1);
  });

  await check("popup renders live site status and rejects restricted pages", async () => {
    const popup = await context.newPage();
    await page.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator("#origin").filter({ hasText: origin }).waitFor();
    assert.equal(await popup.locator("#count").textContent(), "Правил скрытия: 0");
    assert.equal(await popup.locator("#enabled").isChecked(), true);
    assert.equal(await popup.locator("#reset").isDisabled(), true);
    const restricted = await context.newPage();
    await restricted.goto("chrome://version");
    await popup.reload();
    await popup.locator("#message").filter({ hasText: "не поддерживается" }).waitFor();
    assert.equal(await popup.locator("#start").isDisabled(), true);
    await restricted.close();
    await popup.close();
  });

  await start();
  await page.locator("#sidebar").click();
  await visible("#sidebar", false);
  await page.screenshot({ path: path.join(results, "customization.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`\n${passed} browser scenarios passed. Screenshot: test-results/customization.png`);
})().catch(async error => {
  console.error(error);
  if (context) {
    const page = context.pages().find(item => item.url().startsWith("http"));
    if (page) await page.screenshot({ path: path.join(results, "failure.png") }).catch(() => {});
  }
  process.exitCode = 1;
}).finally(async () => {
  if (context) await context.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  // Retain no user data; only this test-created temporary profile is removed.
  const resolved = path.resolve(profile);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("custom-read-mode-test-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
