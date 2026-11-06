(() => {
  "use strict";
  if (globalThis.__customViewModeLoaded) return;
  globalThis.__customViewModeLoaded = true;

  const C = globalThis.CRMCore;
  const S = globalThis.CRMSelectors;
  const F = globalThis.CRMFit;
  const token = crypto.randomUUID();
  const applied = { saved: [], preview: [] };
  const versions = { saved: 0, preview: 0 };
  let styleTail = Promise.resolve();
  let refreshVersion = 0;
  let session = null;
  let lastURL = location.href;
  let layoutFrame = 0;
  let previewVersion = 0;
  let savedFit = null;
  let pageActive = true;
  const fitController = new F.Controller({
    onStatus(status) {
      if (session) {
        session.ui.fitStatus.textContent = status.message;
        session.ui.fitStatus.dataset.state = status.state;
        renderSelection();
        scheduleLayout();
      }
    },
    beforeScroll(element) {
      if (!session) return;
      for (const [node, position] of F.captureScroll(element)) {
        if (!session.scrollBaseline.has(node)) session.scrollBaseline.set(node, position);
      }
    }
  });

  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "Расширение недоступно. Перезагрузите страницу.");
    return response;
  }

  function showError(error) {
    if (session) session.ui.error.textContent = error.message || String(error);
    else console.warn("CustomViewMode:", error);
  }

  function setLayer(layer, selectors) {
    const next = C.validateSelectors(selectors);
    const version = ++versions[layer];
    const task = styleTail.catch(() => {}).then(async () => {
      if (version !== versions[layer]) return;
      await request({ type: "STYLE", layer, token, previous: applied[layer], selectors: next });
      applied[layer] = next;
      fitController.refresh();
      if (session) scheduleLayout();
    });
    styleTail = task;
    void task.catch(showError);
    return task;
  }

  async function refreshRules() {
    const version = ++refreshVersion;
    const url = location.href;
    const result = await request({ type: "GET_RULES", url });
    if (version !== refreshVersion || url !== location.href) return;
    await setLayer("saved", result.selectors);
    if (version !== refreshVersion || url !== location.href) return;
    const changed = savedFit?.selector !== result.fit?.selector;
    savedFit = result.fit || null;
    syncFit({ reveal: changed && !currentFitAction() });
    return result;
  }

  function currentSelectors() {
    return session ? session.actions.filter(action => action.type === "hide")
      .map(action => action.all ? action.rules.group.selector : action.rules.single.selector) : [];
  }

  function currentFitAction() {
    return session?.actions.slice().reverse().find(action => action.type === "fit") || null;
  }

  function syncFit({ reveal = false } = {}) {
    const selector = pageActive ? currentFitAction()?.rules.single.selector || savedFit?.selector || null : null;
    fitController.setRule(selector, { reveal });
    if (session) {
      session.ui.fitStatus.textContent = fitController.status.message;
      renderSelection();
    }
  }

  async function updatePreview({ reveal = false, restore = null } = {}) {
    const version = ++previewVersion;
    try {
      await setLayer("preview", currentSelectors());
      if (version !== previewVersion) return;
      syncFit({ reveal });
      if (restore) requestAnimationFrame(() => {
        if (version === previewVersion) F.restoreScroll(restore);
      });
    } catch (error) { showError(error); }
  }

  function renderSelection() {
    const state = session;
    if (!state) return;
    const last = state.actions.at(-1);
    const fitting = state.ui.mode.value === "fit";
    const activeFit = currentFitAction();
    const selected = fitting ? activeFit : last;
    const target = activeFit?.element?.isConnected ? activeFit.element : fitController.target;
    const selectors = currentSelectors();
    const nodes = new Set(selectors.flatMap(selector => S.query(document, selector)));
    state.ui.count.textContent = `${state.actions.length} действий · ${nodes.size} скрыто${activeFit ? " · 1 автоподгонка" : ""}`;
    state.ui.last.textContent = selected ? `Выбрано: ${selected.label}` : fitting
      ? "Щёлкните по блоку, который нужно подогнать под окно." : "Наведите указатель на элемент и щёлкните по нему.";
    state.ui.allField.hidden = fitting;
    state.ui.matches.hidden = fitting;
    state.ui.fitControls.hidden = !fitting;
    state.ui.fitStatus.hidden = !activeFit && !savedFit;
    state.ui.mode.disabled = state.busy;
    state.ui.parent.disabled = state.busy || !S.selectable(target?.parentElement);
    state.ui.child.disabled = state.busy || !activeFit?.trail[0]?.isConnected;
    state.ui.all.disabled = state.busy || last?.type !== "hide" || last.rules.group.count < 2;
    state.ui.all.checked = last?.type === "hide" && last.all;
    state.ui.matches.textContent = last?.type === "hide" ? `Совпадений: ${last.all ? S.query(document, last.rules.group.selector).length : 1}` : "";
    state.ui.warning.textContent = state.actions.some(action => (action.type === "hide" && action.all ? action.rules.group : action.rules.single).positional)
      ? "Есть правило, зависящее от расположения элемента. При изменении порядка блоков результат может измениться." : "";
    state.ui.accept.disabled = state.busy || !state.actions.length;
    state.ui.undo.disabled = state.busy || !state.actions.length;
    state.ui.cancel.disabled = state.busy;
    state.ui.scope.disabled = state.busy;
    state.ui.section.disabled = state.busy;
  }

  function select(element, { trail = [] } = {}) {
    if (!session || session.busy || !S.selectable(element)) return;
    try {
      const rules = S.build(element);
      C.validateSelectors([rules.single.selector, rules.group.selector]);
      if (session.actions.length >= 500) throw new Error("Достигнут лимит: 500 действий за сеанс. Сохраните изменения.");
      const type = session.ui.mode.value;
      const scrollSnapshot = F.captureScroll(element);
      for (const [node, position] of scrollSnapshot) {
        if (!session.scrollBaseline.has(node)) session.scrollBaseline.set(node, position);
      }
      session.actions.push({ type, rules, all: false, element, trail, scrollSnapshot,
        label: element.localName + (element.id ? `#${element.id}` : "") });
      session.ui.error.textContent = "";
      session.ui.outline.hidden = true;
      renderSelection();
      void updatePreview({ reveal: type === "fit" });
    } catch (error) { showError(error); }
  }

  function undo() {
    if (!session || session.busy) return;
    const removed = session.actions.pop();
    session.ui.error.textContent = "";
    renderSelection();
    void updatePreview({ restore: removed?.scrollSnapshot });
  }

  function cancel() {
    if (!session || session.busy) return;
    finish();
  }

  function finish({ restoreScroll = true } = {}) {
    if (!session) return;
    const state = session;
    session.observer.disconnect();
    session.ui.host.remove();
    session = null;
    void updatePreview({ restore: restoreScroll && state.href === location.href ? state.scrollBaseline : null });
  }

  async function accept() {
    const state = session;
    if (!state || state.busy || !state.actions.length) return;
    try {
      const scope = C.makeScope(state.href, state.ui.scope.value, state.ui.section.value);
      const selectors = C.validateSelectors(currentSelectors());
      const fitAction = currentFitAction();
      const fit = fitAction ? C.validateFit({ selector: fitAction.rules.single.selector }) : undefined;
      for (const selector of [...selectors, ...(fit ? [fit.selector] : [])]) {
        document.querySelectorAll(selector); // Reject invalid CSS before it is persisted.
        if (document.documentElement.matches(selector) || document.body?.matches(selector)) {
          throw new Error("Правило затрагивает корневой элемент страницы.");
        }
      }
      if (fit && S.query(document, fit.selector).length !== 1) throw new Error("Для автоподгонки нужен ровно один элемент. Выберите блок заново.");
      state.busy = true;
      state.ui.error.textContent = "";
      state.ui.accept.textContent = "Сохранение…";
      renderSelection();
      await setLayer("preview", selectors);
      if (state !== session || location.href !== state.href) throw new Error("Страница изменилась. Настройте её заново.");
      await request({ type: "SAVE", url: state.href, scope, selectors, ...(fit ? { fit } : {}) });
      if (state !== session) return;
      await refreshRules();
      if (state === session) finish({ restoreScroll: false });
    } catch (error) {
      if (state === session) {
        state.busy = false;
        state.ui.accept.textContent = "Принять";
        renderSelection();
        showError(error);
      }
    }
  }

  function createUI() {
    const host = document.createElement("div");
    host.setAttribute("data-crm-root", "");
    for (const [name, value] of Object.entries({ all: "initial", position: "fixed", inset: "0", width: "100%", height: "100%", "z-index": "2147483647", "pointer-events": "none", display: "block", visibility: "visible", opacity: "1", "color-scheme": "light" })) {
      host.style.setProperty(name, value, "important");
    }
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; color-scheme: light; }
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        .outline { position: fixed; pointer-events: none; border: 2px solid #2684ff; background: #2684ff22; border-radius: 3px; z-index: 1; }
        .shields { position: fixed; inset: 0; pointer-events: none; }
        .shield { position: fixed; pointer-events: auto; cursor: crosshair; }
        .panel { position: fixed; right: 20px; bottom: 20px; width: 310px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; pointer-events: auto; z-index: 2; color: #1e293b; font: 13px/1.5 system-ui, -apple-system, sans-serif; background: rgba(248,250,252,.93); backdrop-filter: blur(14px); border: 1px solid rgba(148,163,184,.6); border-radius: 14px; box-shadow: 0 12px 45px #0f172a33; }
        .header { display: flex; align-items: center; justify-content: space-between; padding: 13px 15px; border-bottom: 1px solid #cbd5e1; cursor: move; touch-action: none; user-select: none; }
        .header strong { font-size: 14px; letter-spacing: -.2px; }
        .grip { color: #64748b; font-size: 18px; }
        .body { padding: 12px 15px 15px; }
        .hint { margin: 0 0 10px; color: #475569; overflow-wrap: anywhere; }
        .count { font-weight: 600; margin: 0 0 10px; }
        .label { display: block; margin: 12px 0 5px; font-size: 12px; font-weight: 600; }
        select, input[type=text] { width: 100%; padding: 8px 9px; border: 1px solid #94a3b8; border-radius: 7px; background: #fff; color: #0f172a; font: inherit; }
        .check { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
        input[type=checkbox] { accent-color: #2563eb; width: 16px; height: 16px; margin: 0; }
        .small { color: #64748b; font-size: 11px; margin-top: 4px; }
        .warning { color: #92400e; background: #fef3c7; border-radius: 6px; padding: 7px; margin-top: 10px; font-size: 12px; }
        .warning:empty, .error:empty { display: none; }
        .error { color: #b91c1c; margin-top: 10px; font-size: 12px; overflow-wrap: anywhere; }
        .buttons { display: flex; gap: 8px; margin-top: 14px; }
        button { border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 7px; background: #fff; color: #334155; cursor: pointer; font: 600 12px/1.5 system-ui, sans-serif; }
        button.primary { background: #2563eb; border-color: #2563eb; color: white; flex: 1; }
        button:disabled, input:disabled, select:disabled { opacity: .5; cursor: default; }
        button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
        .undo { margin-top: 9px; background: transparent; border: none; padding: 0; font-size: 11px; color: #475569; }
        .mode-label { margin-top: 0; }
        .mode { margin-bottom: 12px; }
        .fit-controls { display: flex; gap: 6px; margin: 10px 0; }
        .fit-controls button { padding: 6px 8px; flex: 1; font-size: 11px; }
        .fit-status { color: #1d4ed8; background: #dbeafe; padding: 7px; border-radius: 6px; margin-top: 10px; font-size: 12px; overflow-wrap: anywhere; }
        .fit-status[data-state=ambiguous], .fit-status[data-state=unsupported], .fit-status[data-state=error] { color: #92400e; background: #fef3c7; }
        .fit-status:empty { display: none; }
      </style>
      <div class="shields"></div>
      <div class="outline" hidden></div>
      <section class="panel" role="dialog" aria-label="Настройка вида страницы" tabindex="-1">
        <div class="header"><strong>CustomViewMode</strong><span class="grip" aria-hidden="true">⠿</span></div>
        <div class="body">
          <label class="label mode-label" for="mode">Действие при выборе элемента</label>
          <select id="mode" class="mode"><option value="hide">Скрывать</option><option value="fit">Подогнать под окно</option></select>
          <p class="hint last"></p>
          <p class="count" aria-live="polite"></p>
          <label class="check all-field"><input class="all" type="checkbox" disabled> Все похожие элементы</label>
          <div class="small matches"></div>
          <div class="fit-controls" hidden><button class="parent" type="button">Выбрать родителя</button><button class="child" type="button">Вернуться к дочернему</button></div>
          <div class="fit-status" aria-live="polite"></div>
          <label class="label" for="scope">Применять к</label>
          <select id="scope"><option value="site">Всему сайту</option><option value="section">Разделу сайта</option><option value="page">Текущей странице</option></select>
          <div class="section-field" hidden><label class="label" for="section">Путь раздела</label><input id="section" type="text" placeholder="/articles" spellcheck="false"></div>
          <div class="small scope-hint"></div>
          <div class="warning"></div>
          <div class="error" role="alert"></div>
          <div class="buttons"><button class="primary accept" type="button">Принять</button><button class="cancel" type="button">Отклонить</button></div>
          <button class="undo" type="button">↶ Отменить шаг · Ctrl+Z</button>
          <div class="small">Esc — отклонить все изменения сеанса</div>
        </div>
      </section>`;
    const ui = { host, root };
    for (const name of ["panel", "header", "outline", "shields", "last", "count", "all", "matches", "warning", "error", "accept", "cancel", "undo"]) ui[name] = root.querySelector("." + name);
    ui.scope = root.querySelector("#scope");
    ui.section = root.querySelector("#section");
    ui.mode = root.querySelector("#mode");
    ui.allField = root.querySelector(".all-field");
    ui.fitControls = root.querySelector(".fit-controls");
    ui.fitStatus = root.querySelector(".fit-status");
    ui.parent = root.querySelector(".parent");
    ui.child = root.querySelector(".child");
    const section = C.parentSection(location.href);
    ui.scope.querySelector('[value="section"]').disabled = !section;
    ui.section.value = section || "";
    function scopeHint() {
      root.querySelector(".section-field").hidden = ui.scope.value !== "section";
      root.querySelector(".scope-hint").textContent = ui.scope.value === "site" ? location.origin :
        ui.scope.value === "page" ? location.pathname + location.search : "Раздел и все вложенные пути";
      scheduleLayout();
    }
    ui.scope.addEventListener("change", scopeHint);
    scopeHint();
    ui.accept.addEventListener("click", () => { void accept(); });
    ui.cancel.addEventListener("click", cancel);
    ui.undo.addEventListener("click", undo);
    ui.mode.addEventListener("change", () => { renderSelection(); scheduleLayout(); });
    ui.parent.addEventListener("click", () => {
      const current = currentFitAction();
      const target = current?.element?.isConnected ? current.element : fitController.target;
      if (S.selectable(target?.parentElement)) select(target.parentElement, { trail: [target, ...(current?.trail || [])] });
    });
    ui.child.addEventListener("click", () => {
      const current = currentFitAction();
      const child = current?.trail[0];
      if (child?.isConnected) select(child, { trail: current.trail.slice(1) });
    });
    ui.all.addEventListener("change", () => {
      if (!session || session.busy) return;
      const last = session.actions.at(-1);
      if (last?.type !== "hide") return;
      last.all = ui.all.checked;
      renderSelection();
      void updatePreview();
    });
    root.addEventListener("click", event => event.stopPropagation());
    let drag = null;
    ui.header.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      const rect = ui.panel.getBoundingClientRect();
      drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      ui.header.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    ui.header.addEventListener("pointermove", event => {
      if (!drag) return;
      placePanel(ui.panel, event.clientX - drag.x, event.clientY - drag.y);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) ui.header.addEventListener(type, () => { drag = null; });
    document.documentElement.append(host);
    return ui;
  }

  function placePanel(panel, left, top) {
    const rect = panel.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(left, innerWidth - rect.width - 8)) + "px";
    panel.style.top = Math.max(8, Math.min(top, innerHeight - rect.height - 8)) + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function outline(element) {
    if (!session || !S.selectable(element)) {
      if (session) session.ui.outline.hidden = true;
      return;
    }
    const rect = element.getBoundingClientRect();
    const node = session.ui.outline;
    Object.assign(node.style, { left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
    node.hidden = false;
  }

  function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      if (!session) return;
      const { ui } = session;
      ui.outline.hidden = true;
      if (!ui.host.isConnected) document.documentElement.append(ui.host);
      const rect = ui.panel.getBoundingClientRect();
      if (rect.left < 8 || rect.top < 8 || rect.right > innerWidth - 8 || rect.bottom > innerHeight - 8) {
        placePanel(ui.panel, rect.left, rect.top);
      }
      // A shield selects the iframe element, without reading or injecting into its document.
      const frames = [...document.querySelectorAll("iframe")].filter(frame => {
        const box = frame.getBoundingClientRect();
        return box.width && box.height && box.bottom > 0 && box.top < innerHeight && getComputedStyle(frame).visibility !== "hidden";
      });
      ui.shields.replaceChildren(...frames.map(frame => {
        const box = frame.getBoundingClientRect();
        const shield = document.createElement("div");
        shield.className = "shield";
        Object.assign(shield.style, { left: box.left + "px", top: box.top + "px", width: box.width + "px", height: box.height + "px" });
        shield.addEventListener("pointermove", () => outline(frame));
        shield.addEventListener("pointerdown", event => event.preventDefault());
        shield.addEventListener("click", event => { event.stopPropagation(); select(frame); scheduleLayout(); });
        return shield;
      }));
      if (ui.mode.value === "fit") {
        const selected = currentFitAction()?.element;
        const target = selected?.isConnected ? selected : fitController.target;
        if (target?.isConnected) outline(target);
      }
    });
  }

  async function startSession() {
    if (session) {
      session.ui.panel.focus({ preventScroll: true });
      return;
    }
    if (!["text/html", "application/xhtml+xml"].includes(document.contentType)) throw new Error("Этот тип документа не поддерживается.");
    if (!document.documentElement) await new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    await refreshRules();
    if (session) return;
    const ui = createUI();
    session = { href: location.href, ui, actions: [], busy: false, scrollBaseline: F.captureScroll(fitController.target), observer: new MutationObserver(records => {
      if (records.some(record => !ui.host.contains(record.target))) scheduleLayout();
    }) };
    session.observer.observe(document.documentElement, { childList: true, subtree: true });
    renderSelection();
    ui.fitStatus.textContent = fitController.status.message;
    scheduleLayout();
    ui.panel.focus({ preventScroll: true });
  }

  function isUI(event) { return session && event.composedPath().includes(session.ui.host); }

  // Register at document_start, before the page installs its normal event handlers.
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick"]) {
    window.addEventListener(type, event => {
      if (!session || isUI(event) || event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (type === "click" && !session.busy) select(event.target);
    }, { capture: true, passive: false });
  }
  window.addEventListener("pointermove", event => {
    if (session && !session.busy) outline(isUI(event) ? null : event.target);
  }, { capture: true, passive: true });
  window.addEventListener("keydown", event => {
    if (!session || session.busy) return;
    const editing = isUI(event) && event.composedPath().some(node => node instanceof Element && node.matches("input[type=text], select, textarea"));
    if (event.key === "Escape") {
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
    } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z" && !editing) {
      event.preventDefault(); event.stopImmediatePropagation(); undo();
    }
  }, { capture: true });
  window.addEventListener("resize", scheduleLayout, { passive: true });
  window.addEventListener("scroll", scheduleLayout, { passive: true, capture: true });

  function checkLocation() {
    if (lastURL !== location.href) {
      lastURL = location.href;
      if (session) finish({ restoreScroll: false });
      savedFit = null;
      fitController.clear();
    }
    if (!session) void setLayer("preview", []);
    void refreshRules().catch(showError);
  }
  window.addEventListener("popstate", checkLocation);
  window.addEventListener("hashchange", checkLocation);
  window.addEventListener("pageshow", event => {
    pageActive = true;
    if (event.persisted) savedFit = null;
    checkLocation();
  });
  window.addEventListener("pagehide", () => {
    pageActive = false;
    refreshVersion++;
    savedFit = null;
    if (session) finish({ restoreScroll: false });
    fitController.clear();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === "PING") { sendResponse({ ok: true }); return; }
    if (message.type === "START") {
      startSession().then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "NAVIGATION") { checkLocation(); sendResponse({ ok: true }); return; }
    if (message.type === "SITE_CHANGED") {
      if (["toggle", "reset", "clear_fit"].includes(message.reason) && session) finish();
      refreshRules().then(() => sendResponse({ ok: true }), error => {
        showError(error); sendResponse({ ok: false, error: error.message });
      });
      return true;
    }
  });

  void refreshRules().catch(showError);
})();
