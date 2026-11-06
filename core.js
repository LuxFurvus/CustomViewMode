/* Shared pure helpers: loaded as a content script, worker import and in Node tests. */
(() => {
  "use strict";
  const STORAGE_KEY = "customViewMode";
  const VERSION = 2;

  function pageURL(value) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Эта страница не поддерживается.");
    if (["chromewebstore.google.com", "chrome.google.com"].includes(url.hostname) &&
        (url.hostname === "chromewebstore.google.com" || url.pathname.startsWith("/webstore"))) {
      throw new Error("Chrome запрещает настройку страниц Chrome Web Store.");
    }
    url.hash = "";
    url.username = "";
    url.password = "";
    return url;
  }

  function sectionPath(value) {
    if (typeof value !== "string" || !value.startsWith("/") || /[?#\\\r\n]/.test(value)) {
      throw new Error("Укажите путь раздела, например /articles.");
    }
    const parsed = new URL(value, "https://section.invalid");
    if (parsed.origin !== "https://section.invalid") throw new Error("Нужен путь, а не адрес сайта.");
    return parsed.pathname.replace(/\/+$/, "") || "/";
  }

  function parentSection(value) {
    const path = pageURL(value).pathname;
    if (path === "/") return null;
    const trimmed = path.replace(/\/+$/, "");
    // A single-segment route is itself a useful section; /article/42 suggests /article.
    return path.endsWith("/") ? trimmed : trimmed.slice(0, trimmed.lastIndexOf("/")) || trimmed;
  }

  function makeScope(value, mode, path) {
    const url = pageURL(value);
    if (!["site", "section", "page"].includes(mode)) throw new Error("Неизвестная область действия.");
    const scope = { mode, origin: url.origin };
    if (mode === "page") scope.path = url.pathname + url.search;
    if (mode === "section") {
      scope.path = sectionPath(path);
      if (scope.path === "/") throw new Error("Для корня выберите «Весь сайт».");
      if (!pathWithin(url.pathname, scope.path)) throw new Error("Текущая страница должна входить в раздел.");
    }
    return scope;
  }

  function pathWithin(path, prefix) {
    return path === prefix || path.startsWith(prefix + "/");
  }

  function matches(scope, value) {
    const url = pageURL(value);
    if (scope.origin !== url.origin) return false;
    if (scope.mode === "site") return true;
    if (scope.mode === "page") return scope.path === url.pathname + url.search;
    return scope.mode === "section" && pathWithin(url.pathname, scope.path);
  }

  function emptyStore() { return { version: VERSION, groups: [], sites: {} }; }

  function readStore(value) {
    if (value === undefined) return emptyStore();
    if (!value || ![1, VERSION].includes(value.version) || !Array.isArray(value.groups) ||
        !value.sites || typeof value.sites !== "object" || Array.isArray(value.sites)) {
      throw new Error("Неподдерживаемый формат правил. Данные не изменены.");
    }
    // Version 1 groups are already compatible: only the optional fit rule is new.
    return value.version === VERSION ? value : { ...structuredClone(value), version: VERSION };
  }

  function validateSelectors(selectors) {
    if (!Array.isArray(selectors) || selectors.length > 5000) throw new Error("Слишком много правил для одной страницы (максимум 5000).");
    return [...new Set(selectors.map(selector => {
      if (typeof selector !== "string" || !selector.trim() || selector.length > 4096 || /[\r\n\u0000]/.test(selector)) {
        throw new Error("Некорректное правило скрытия.");
      }
      // CSS.escape legitimately emits escaped braces/semicolons inside identifiers.
      // Only unescaped rule delimiters could break out of our generated CSS block.
      for (let index = 0; index < selector.length; index++) {
        if (selector[index] === "\\") { index++; continue; }
        if (/[{};]/.test(selector[index])) throw new Error("Некорректное правило скрытия.");
      }
      return selector.trim();
    }))].sort();
  }

  function scopeKey(scope) { return JSON.stringify([scope.origin, scope.mode, scope.path || ""]); }

  function validateFit(fit) {
    if (!fit || typeof fit !== "object" || Array.isArray(fit)) throw new Error("Некорректное правило автоподгонки.");
    return { selector: validateSelectors([fit.selector])[0] };
  }

  function addGroup(store, scope, selectors, id, fit) {
    const next = structuredClone(store);
    const checked = validateSelectors(selectors);
    const checkedFit = fit === undefined ? undefined : validateFit(fit);
    if (!checked.length && !checkedFit) return next;
    const existing = next.groups.find(group => scopeKey(group.scope) === scopeKey(scope));
    if (existing) {
      existing.selectors = [...new Set([...existing.selectors, ...checked])].sort();
      if (checkedFit) existing.fit = checkedFit;
    } else next.groups.push({ id, scope, selectors: checked, ...(checkedFit ? { fit: checkedFit } : {}) });
    next.sites[scope.origin] = { enabled: true };
    return next;
  }

  function siteState(store, value) {
    const origin = pageURL(value).origin;
    return {
      origin,
      enabled: store.sites[origin]?.enabled !== false,
      count: store.groups.filter(group => group.scope.origin === origin)
        .reduce((count, group) => count + group.selectors.length, 0),
      fitCount: store.groups.filter(group => group.scope.origin === origin && group.fit).length
    };
  }

  function applicableSelectors(store, value) {
    if (!siteState(store, value).enabled) return [];
    return [...new Set(store.groups.filter(group => matches(group.scope, value)).flatMap(group => group.selectors))].sort();
  }

  function applicableFit(store, value) {
    if (!siteState(store, value).enabled) return null;
    const rank = scope => scope.mode === "page" ? 2 : scope.mode === "section" ? 1 : 0;
    const groups = store.groups.filter(group => group.fit && matches(group.scope, value));
    groups.sort((a, b) => rank(b.scope) - rank(a.scope) || (b.scope.path?.length || 0) - (a.scope.path?.length || 0));
    return groups.length ? { ...validateFit(groups[0].fit), scope: groups[0].scope } : null;
  }

  function compileCSS(selectors, token, layer) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(token) || !["saved", "preview"].includes(layer)) throw new Error("Некорректный сеанс.");
    const rules = validateSelectors(selectors).map(selector =>
      `:is(${selector}):not(html):not(body):not([data-crm-root]) { display: none !important; }`
    );
    return rules.length ? `/* CustomViewMode ${token} ${layer} */\n${rules.join("\n")}` : "";
  }

  function serialQueue() {
    let tail = Promise.resolve();
    return task => {
      const result = tail.then(task);
      tail = result.catch(() => {});
      return result;
    };
  }

  const api = { STORAGE_KEY, VERSION, pageURL, sectionPath, parentSection, makeScope, matches,
    emptyStore, readStore, validateSelectors, validateFit, addGroup, siteState, applicableSelectors, applicableFit, compileCSS, serialQueue };
  globalThis.CRMCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
