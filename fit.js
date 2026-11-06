/* One reversible, in-place fit per document. No clones and no browser zoom changes. */
(() => {
  "use strict";
  const GAP = 16;
  const root = () => document.scrollingElement || document.documentElement;

  function captureScroll(element) {
    const positions = new Map([[null, { left: scrollX, top: scrollY }]]);
    for (let node = element?.parentElement; node; node = node.parentElement) {
      if (node !== root()) positions.set(node, { left: node.scrollLeft, top: node.scrollTop });
    }
    return positions;
  }

  function restoreScroll(positions) {
    if (!positions) return;
    for (const [node, position] of positions) {
      if (node?.isConnected) node.scrollTo({ ...position, behavior: "instant" });
    }
    const windowPosition = positions.get(null);
    if (windowPosition) window.scrollTo({ ...windowPosition, behavior: "instant" });
  }

  function sizeKey(node) {
    const rect = node.getBoundingClientRect();
    return `${rect.width.toFixed(2)}:${rect.height.toFixed(2)}:${node.clientWidth}:${node.clientHeight}`;
  }

  function isUI(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!element?.closest("[data-crm-root]");
  }

  function borderSize(element, computed, axis) {
    const dimension = parseFloat(computed[axis]);
    const sides = axis === "width" ? ["Left", "Right"] : ["Top", "Bottom"];
    if (Number.isFinite(dimension) && dimension > 0) {
      return computed.boxSizing === "border-box" ? dimension : dimension + sides.reduce((sum, side) =>
        sum + (parseFloat(computed[`padding${side}`]) || 0) + (parseFloat(computed[`border${side}Width`]) || 0), 0);
    }
    return axis === "width" ? element.offsetWidth : element.offsetHeight;
  }

  function contentBox(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const factorX = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
    const factorY = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
    return {
      width: Math.max(0, element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)) * factorX,
      height: Math.max(0, element.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0)) * factorY,
      clipX: /^(hidden|clip|auto|scroll)$/.test(style.overflowX),
      clipY: /^(hidden|clip|auto|scroll)$/.test(style.overflowY)
    };
  }

  class Controller {
    constructor({ onStatus = () => {}, beforeScroll = () => {} } = {}) {
      this.onStatus = onStatus;
      this.beforeScroll = beforeScroll;
      this.selector = null;
      this.target = null;
      this.frame = 0;
      this.owned = new Map();
      this.observedSizes = new Map();
      this.status = { state: "idle", message: "" };
      this.refresh = this.refresh.bind(this);
      this.userMoved = () => { this.needsReveal = false; };
      this.keyMoved = event => {
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) && !isUI(event.target)) this.userMoved();
      };
      this.loaded = event => {
        if (!this.target || event.target === document || this.target.contains(event.target) || event.target?.tagName === "LINK") this.refresh();
      };
    }

    setRule(selector, { reveal = true } = {}) {
      if (selector === this.selector) {
        if (reveal) this.needsReveal = true;
        this.refresh();
        return;
      }
      this.clear(false);
      if (!selector) { this.report("idle", ""); return; }
      this.selector = selector;
      this.needsReveal = reveal;
      this.mutations = new MutationObserver(records => {
        const relevant = records.some(record => {
          if (isUI(record.target)) return false;
          // Styles outside the target/ancestors cannot change its matching or geometry directly.
          if (record.type === "attributes" && record.attributeName === "style" && this.target &&
              !this.target.contains(record.target) && !record.target.contains(this.target)) return false;
          return true;
        });
        if (relevant) this.refresh();
      });
      this.mutations.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
      this.resizes = new ResizeObserver(entries => {
        if (entries.some(entry => this.observedSizes.get(entry.target) !== sizeKey(entry.target))) this.refresh();
      });
      window.addEventListener("resize", this.refresh, { passive: true });
      window.visualViewport?.addEventListener("resize", this.refresh, { passive: true });
      window.addEventListener("wheel", this.userMoved, { passive: true, capture: true });
      window.addEventListener("touchmove", this.userMoved, { passive: true, capture: true });
      window.addEventListener("pointerdown", this.userMoved, { passive: true, capture: true });
      window.addEventListener("keydown", this.keyMoved, true);
      for (const type of ["load", "loadedmetadata"]) document.addEventListener(type, this.loaded, true);
      document.fonts?.addEventListener("loadingdone", this.refresh);
      this.refresh();
    }

    report(state, message, scale = null) {
      this.status = { state, message, scale, element: this.target };
      this.onStatus(this.status);
    }

    refresh() {
      if (!this.selector || this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        try { this.measure(); }
        catch (error) {
          this.restoreStyles();
          this.rememberSizes();
          this.report("error", "Не удалось подогнать элемент: " + error.message);
        }
      });
    }

    setProperty(name, value) {
      let entry = this.owned.get(name);
      if (!entry) {
        entry = { original: this.target.style.getPropertyValue(name), priority: this.target.style.getPropertyPriority(name), applied: null };
        this.owned.set(name, entry);
      }
      this.target.style.setProperty(name, value, "important");
      entry.applied = this.target.style.getPropertyValue(name);
    }

    restoreStyles() {
      if (!this.target) return;
      for (const [name, entry] of this.owned) {
        if (entry.applied === null) continue;
        const value = this.target.style.getPropertyValue(name);
        const priority = this.target.style.getPropertyPriority(name);
        // Keep edits made by the website while our rule was active.
        if (value !== entry.applied || priority !== "important") {
          entry.original = value;
          entry.priority = priority;
        }
        if (entry.original) this.target.style.setProperty(name, entry.original, entry.priority);
        else this.target.style.removeProperty(name);
        entry.applied = null;
      }
      this.mutations?.takeRecords();
    }

    releaseTarget() {
      this.resizes?.disconnect();
      this.restoreStyles();
      this.owned.clear();
      this.observedSizes.clear();
      this.watched = null;
      this.target = null;
    }

    watch() {
      if (!this.target) return;
      const nodes = new Set([this.target, ...this.target.querySelectorAll("*")]);
      for (let node = this.target.parentElement; node; node = node.parentElement) nodes.add(node);
      for (const node of this.observedSizes.keys()) {
        if (!nodes.has(node)) { this.resizes.unobserve(node); this.observedSizes.delete(node); }
      }
      for (const node of nodes) {
        if (!this.observedSizes.has(node)) this.resizes.observe(node);
      }
      this.watched = nodes;
      this.rememberSizes();
    }

    rememberSizes() {
      for (const node of this.watched || []) {
        if (node.isConnected) this.observedSizes.set(node, sizeKey(node));
      }
      this.mutations?.takeRecords();
    }

    availableSpace() {
      let width = Math.max(0, Math.min(innerWidth, document.documentElement.clientWidth, window.visualViewport?.width || Infinity) - 2 * GAP);
      let height = Math.max(0, Math.min(innerHeight, window.visualViewport?.height || Infinity) - 2 * GAP);
      let constrainedParent = false;
      for (let node = this.target.parentElement; node && node !== root(); node = node.parentElement) {
        const box = contentBox(node);
        if (!constrainedParent && box.width > 0) { width = Math.min(width, box.width); constrainedParent = true; }
        if (box.clipX) width = Math.min(width, box.width);
        if (box.clipY) height = Math.min(height, box.height);
      }
      return { width, height };
    }

    measure() {
      const matches = globalThis.CRMSelectors.query(document, this.selector);
      if (matches.length !== 1) {
        this.releaseTarget();
        this.report(matches.length ? "ambiguous" : "missing", matches.length
          ? "Автоподгонка приостановлена: селектор совпал с несколькими элементами. Выберите блок заново."
          : "Ожидание элемента для автоподгонки…");
        return;
      }
      if (this.target !== matches[0]) { this.releaseTarget(); this.target = matches[0]; }
      const element = this.target;
      this.restoreStyles();
      const supported = element instanceof HTMLElement || (element instanceof SVGSVGElement && !element.ownerSVGElement);
      if (!supported) {
        this.report("unsupported", "Для этого элемента выберите родительский HTML-блок или внешний SVG.");
        return;
      }
      let style = getComputedStyle(element);
      if (!element.getClientRects().length || style.display === "none" || ["hidden", "collapse"].includes(style.visibility)) {
        this.watch();
        this.report("hidden", "Автоподгонка ожидает: выбранный блок или его родитель скрыт.");
        return;
      }
      if (style.display === "contents") {
        this.watch();
        this.report("unsupported", "У элемента нет собственного блока (display: contents). Выберите родителя.");
        return;
      }
      // Website transitions must not animate our measurement/apply cycle.
      // Touch the longhand only, preserving the site's other transition settings.
      this.setProperty("transition-property", "none");
      if (style.display === "inline" && element instanceof HTMLElement) this.setProperty("display", "inline-block");
      style = getComputedStyle(element);
      const originalZoom = parseFloat(style.zoom) || 1;
      const width = borderSize(element, style, "width");
      const height = borderSize(element, style, "height");
      const rect = element.getBoundingClientRect();
      const available = this.availableSpace();
      if (!(width > 0 && height > 0 && rect.width > 0 && rect.height > 0 && available.width > 0 && available.height > 0)) {
        this.restoreStyles();
        this.watch();
        this.report("empty", "Ожидание измеримых размеров блока или его контейнера…");
        return;
      }
      let scale = Math.min(available.width / rect.width, available.height / rect.height);
      if (!(Number.isFinite(scale) && scale > 0)) throw new Error("Не удалось определить масштаб.");
      this.setProperty("box-sizing", "border-box");
      this.setProperty("width", `${width}px`);
      this.setProperty("height", `${height}px`);
      this.setProperty("min-width", "0px");
      this.setProperty("min-height", "0px");
      this.setProperty("max-width", "none");
      this.setProperty("max-height", "none");
      this.setProperty("flex-shrink", "0");
      this.setProperty("flex-grow", "0");
      this.setProperty("flex-basis", "auto");
      this.setProperty("zoom", String(originalZoom * scale));
      const actual = element.getBoundingClientRect();
      const correction = Math.min(1, available.width / actual.width, available.height / actual.height);
      if (Number.isFinite(correction) && correction > 0 && correction < 0.999) {
        scale *= correction;
        this.setProperty("zoom", String(originalZoom * scale));
      }
      this.watch();
      if (this.needsReveal) {
        this.needsReveal = false;
        this.beforeScroll(element);
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      }
      this.report("fit", `Автоподгонка: ${Math.round(scale * 100)}% · ${Math.round(width)} × ${Math.round(height)}`, scale);
      this.mutations?.takeRecords();
    }

    clear(notify = true) {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.selector = null;
      this.needsReveal = false;
      this.mutations?.disconnect();
      this.resizes?.disconnect();
      this.restoreStyles();
      this.owned.clear();
      this.observedSizes.clear();
      this.watched = null;
      this.target = null;
      window.removeEventListener("resize", this.refresh);
      window.visualViewport?.removeEventListener("resize", this.refresh);
      window.removeEventListener("wheel", this.userMoved, true);
      window.removeEventListener("touchmove", this.userMoved, true);
      window.removeEventListener("pointerdown", this.userMoved, true);
      window.removeEventListener("keydown", this.keyMoved, true);
      for (const type of ["load", "loadedmetadata"]) document.removeEventListener(type, this.loaded, true);
      document.fonts?.removeEventListener("loadingdone", this.refresh);
      if (notify) this.report("idle", "");
    }
  }

  globalThis.CRMFit = { Controller, captureScroll, restoreScroll };
})();
