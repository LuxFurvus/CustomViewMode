(() => {
  "use strict";

  function stable(value) {
    return value.length > 0 && value.length <= 100 &&
      !/(?:^|[-_])(?:css|jsx|sc)[-_]?[a-z0-9]{5,}$/i.test(value) &&
      !/[a-f0-9]{8,}/i.test(value) && !/\d{4,}/.test(value) &&
      !/^(?:active|selected|hover|focus|open|closed|loading|hidden|visible)$/i.test(value);
  }

  function selectable(element, doc = document) {
    return element instanceof doc.defaultView.Element && element.getRootNode() === doc &&
      !["HTML", "BODY", "HEAD", "SCRIPT", "STYLE", "LINK", "META", "TITLE", "NOSCRIPT"].includes(element.tagName) &&
      !element.closest("[data-crm-root]");
  }

  function query(doc, selector) {
    try { return [...doc.querySelectorAll(selector)].filter(element => selectable(element, doc)); }
    catch { return []; }
  }

  function candidates(element, includeID = true) {
    const escape = element.ownerDocument.defaultView.CSS.escape;
    const tag = element.localName;
    const list = [];
    if (includeID && stable(element.id)) list.push("#" + escape(element.id));
    for (const attribute of ["data-testid", "data-test", "data-qa", "aria-label", "role", "name"]) {
      const value = element.getAttribute(attribute);
      // CSS.escape also works in a quoted attribute value and handles quotes/backslashes.
      if (value && stable(value)) list.push(`${tag}[${attribute}="${escape(value)}"]`);
    }
    const classes = [...element.classList].filter(stable).map(name => "." + escape(name));
    if (classes.length) {
      list.push(tag + classes.join(""));
      for (const name of classes) list.push(tag + name);
    }
    list.push(tag);
    return [...new Set(list)];
  }

  function unique(doc, selector, target) {
    const elements = query(doc, selector);
    return elements.length === 1 && elements[0] === target &&
      !doc.documentElement.matches(selector) && !doc.body?.matches(selector);
  }

  function single(element) {
    const doc = element.ownerDocument;
    if (!selectable(element, doc)) throw new Error("Этот элемент нельзя скрыть.");
    for (const selector of candidates(element)) {
      if (unique(doc, selector, element)) return { selector, positional: false };
    }
    // First seek a semantic ancestor before falling back to sibling positions.
    let suffix = candidates(element).find(value => !value.startsWith("#")) || element.localName;
    for (let ancestor = element.parentElement; ancestor && ancestor !== doc.body; ancestor = ancestor.parentElement) {
      for (const prefix of candidates(ancestor)) {
        const selector = prefix + " > " + suffix;
        if (unique(doc, selector, element)) return { selector, positional: false };
      }
      suffix = (candidates(ancestor).find(value => !value.startsWith("#")) || ancestor.localName) + " > " + suffix;
    }
    let path = "";
    for (let current = element; current && current !== doc.body; current = current.parentElement) {
      const siblings = [...current.parentElement.children].filter(node => node.localName === current.localName);
      const part = current.localName + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "");
      path = part + (path ? " > " + path : "");
      if (unique(doc, path, element)) return { selector: path, positional: path.includes(":nth-of-type(") };
      for (const anchor of candidates(current.parentElement)) {
        const selector = anchor + " > " + path;
        if (unique(doc, selector, element)) return { selector, positional: path.includes(":nth-of-type(") };
      }
    }
    throw new Error("Не удалось подобрать безопасное правило для элемента.");
  }

  function group(element, fallback) {
    const doc = element.ownerDocument;
    // Never generalize to a naked tag: an unclassed <div> could otherwise hide the whole page.
    const options = candidates(element, false).filter(selector => selector !== element.localName);
    for (const selector of options) {
      const nodes = query(doc, selector);
      if (nodes.includes(element) && nodes.length > 1 &&
          !nodes.some(node => node !== element && node.contains(element))) {
        return { selector, positional: false, count: nodes.length };
      }
    }
    // Repeated unclassed items can be grouped within their parent, without selecting all tags on the site.
    const parent = element.parentElement;
    if (parent && parent !== doc.body && parent !== doc.documentElement) {
      const anchor = single(parent);
      const selector = anchor.selector + " > " + element.localName;
      const nodes = query(doc, selector);
      if (nodes.length > 1) return { selector, positional: anchor.positional, count: nodes.length };
    }
    return { ...fallback, count: 1 };
  }

  function build(element) {
    const one = single(element);
    return { single: { ...one, count: 1 }, group: group(element, one) };
  }

  globalThis.CRMSelectors = { stable, selectable, query, build };
})();
