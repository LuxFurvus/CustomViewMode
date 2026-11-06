const { test } = require("node:test");
const assert = require("node:assert/strict");
const C = require("../core.js");

test("page scope keeps queries, ignores fragments, and excludes another origin", () => {
  const scope = C.makeScope("https://example.com/a?q=1#first", "page");
  assert.equal(C.matches(scope, "https://example.com/a?q=1#second"), true);
  for (const url of ["https://example.com/a?q=2", "http://example.com/a?q=1", "https://sub.example.com/a?q=1"]) {
    assert.equal(C.matches(scope, url), false);
  }
});

test("section scope respects path boundaries and ignores queries", () => {
  const scope = C.makeScope("https://example.com/articles/42", "section", "/articles/");
  for (const path of ["/articles", "/articles/", "/articles/42?q=2"]) assert.equal(C.matches(scope, "https://example.com" + path), true);
  for (const path of ["/articles-old", "/article", "/other/articles"]) assert.equal(C.matches(scope, "https://example.com" + path), false);
  for (const path of ["//evil.com/path", "/other", "/", "/articles?x=1", "/articles#x", "/articles\\other"]) {
    assert.throws(() => C.makeScope("https://example.com/articles/42", "section", path));
  }
});

test("site scope is confined to the exact scheme, host and port", () => {
  const scope = C.makeScope("https://example.com:8443/a", "site");
  assert.equal(C.matches(scope, "https://example.com:8443/b?x=2"), true);
  assert.equal(C.matches(scope, "https://example.com/b"), false);
  assert.equal(C.matches(scope, "https://www.example.com:8443/b"), false);
});

test("suggest a meaningful parent section, including single segments and directory URLs", () => {
  assert.equal(C.parentSection("https://example.com/"), null);
  assert.equal(C.parentSection("https://example.com/articles/42"), "/articles");
  assert.equal(C.parentSection("https://example.com/articles/"), "/articles");
  assert.equal(C.parentSection("https://example.com/articles"), "/articles");
});

test("unsupported pages and the extension store are rejected", () => {
  for (const url of ["chrome://settings", "file:///a", "https://chromewebstore.google.com/detail/test", "https://chrome.google.com/webstore/detail/test"]) {
    assert.throws(() => C.pageURL(url));
  }
});

test("add rules without mutating input, merge duplicate scopes and selectors", () => {
  const original = C.emptyStore();
  const scope = C.makeScope("https://example.com/a", "site");
  const first = C.addGroup(original, scope, ["#ad", ".sidebar", "#ad"], "one");
  const second = C.addGroup(first, scope, ["#ad", "footer"], "two");
  assert.equal(original.groups.length, 0);
  assert.equal(first.groups[0].selectors.length, 2);
  assert.equal(second.groups.length, 1);
  assert.deepEqual(second.groups[0].selectors, ["#ad", ".sidebar", "footer"]);
});

test("matching groups accumulate; disabling preserves rules", () => {
  let store = C.addGroup(C.emptyStore(), C.makeScope("https://example.com/articles/1", "site"), ["#ad"], "a");
  store = C.addGroup(store, C.makeScope("https://example.com/articles/1", "section", "/articles"), ["#ad", ".aside"], "b");
  store = C.addGroup(store, C.makeScope("https://example.com/articles/1", "page"), ["footer"], "c");
  assert.deepEqual(C.applicableSelectors(store, "https://example.com/articles/1"), ["#ad", ".aside", "footer"]);
  assert.deepEqual(C.applicableSelectors(store, "https://example.com/other"), ["#ad"]);
  store.sites["https://example.com"].enabled = false;
  assert.deepEqual(C.applicableSelectors(store, "https://example.com/articles/1"), []);
  assert.equal(C.siteState(store, "https://example.com/").count, 4);
});

test("CSS layers have distinct identities and protect roots and extension UI", () => {
  const saved = C.compileCSS([".ad"], "document-1", "saved");
  assert.match(saved, /:not\(html\):not\(body\):not\(\[data-crm-root\]\)/);
  assert.match(saved, /display: none !important/);
  assert.notEqual(saved, C.compileCSS([".ad"], "document-1", "preview"));
  assert.equal(C.compileCSS([], "document-1", "saved"), "");
  for (const value of ["div {}", "div; color:red", "\nhtml", "", null]) assert.throws(() => C.validateSelectors([value]));
  assert.throws(() => C.compileCSS([".ad"], "bad*/", "saved"));
});

test("unknown storage versions are preserved by rejecting them", () => {
  assert.deepEqual(C.readStore(undefined), C.emptyStore());
  assert.throws(() => C.readStore({ version: 3, groups: [], sites: {} }));
});

test("serialization prevents lost updates and continues after a failed write", async () => {
  const enqueue = C.serialQueue();
  let value = 0;
  const order = [];
  const jobs = [1, 2, 3].map(i => enqueue(async () => {
    const previous = value;
    await new Promise(resolve => setTimeout(resolve, 3));
    if (i === 2) throw new Error("write failed");
    value = previous + 1;
    order.push(i);
  }));
  const results = await Promise.allSettled(jobs);
  assert.equal(results[1].status, "rejected");
  assert.equal(value, 2);
  assert.deepEqual(order, [1, 3]);
});
