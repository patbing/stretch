/**
 * content.js — the part that touches the page.
 *
 * Rules it never breaks:
 *  - it never rewrites or wraps the author's words; it only appends an
 *    extension-owned inline host at the end of the selection, and removes it
 *    again on request;
 *  - it never sees a credential: the Pollinations key lives in the service
 *    worker, and this script only sends bounded text;
 *  - it renders the generated addition as plain text nodes.
 *
 * Two identities, kept apart on purpose:
 *  - anchorId  : one inserted element (unique). Used for DOM tracking.
 *  - cacheKey  : the content of a stretch (selection + paragraph context).
 *                Used so shrinking and re-expanding costs nothing.
 */
(() => {
  if (window.__stretchLoaded) return;
  window.__stretchLoaded = true;

  const HOST_ATTR = "data-stretch-anchor";
  const DOC_ID =
    (crypto && crypto.randomUUID && crypto.randomUUID()) ||
    `d${Date.now()}${Math.random().toString(16).slice(2)}`;

  const SEL_MAX = 600;
  const CTX_MAX = 1000;

  /** FNV-1a hash — inlined copy of lib/anchor.js (content scripts cannot import modules). */
  function hashString(s) {
    let h = 0x811c9dc5;
    const str = String(s || "");
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }
  /** Stable key for one stretch — inlined copy of lib/anchor.js. */
  function cacheKey(info) {
    const i = info || {};
    const sel = String(i.selection ?? i.text ?? "").trim();
    const b = String(i.before ?? "").trim();
    const a = String(i.after ?? "").trim();
    return `k${hashString(sel + "\u0000" + b + "\u0000" + a)}`;
  }
  /** A fresh DOM identity for one inserted element. */
  function newAnchorId() {
    return `a${Date.now().toString(36)}${Math.random().toString(16).slice(2, 10)}`;
  }

  /** content cache key -> { text, model, cost } for results that were already paid for. */
  const cache = new Map();
  /** anchorId -> host element currently in the page (DOM identity). */
  const hosts = new Map();
  /** requestId -> { anchorId, host, shadow, controller } */
  const pending = new Map();

  let savedInfo = null;
  let floatBtn = null;
  let liveRegion = null;
  let toast = null;
  let selTimer = null;

  /* ------------------------------------------------------------- utilities */

  const cpLen = (s) => Array.from(String(s || "")).length;

  /** The block element that owns a node (never an inline element). */
  function blockOf(node) {
    let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      const display = window.getComputedStyle(el).display;
      if (display !== "inline" && display !== "inline-block" && display !== "contents") {
        if (el !== document.body && el !== document.documentElement) return el;
      }
      el = el.parentElement;
    }
    return document.body;
  }

  /** Never modify an editor, a form field, or a design-mode surface. */
  function isEditableContext(el) {
    if (!el) return false;
    if (el.closest && el.closest("input, textarea, select, option")) return true;
    try {
      if (el.isContentEditable) return true;
    } catch (e) {
      /* ignore */
    }
    try {
      if (document.designMode === "on") return true;
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  function inShadowRoot(el) {
    try {
      const root = el && el.getRootNode ? el.getRootNode() : null;
      return !!(root && root !== document && root.host);
    } catch (e) {
      return false;
    }
  }

  /** Context around the selection, taken from the enclosing block. */
  function contextFor(range) {
    const startBlock = blockOf(range.startContainer);
    const endBlock = blockOf(range.endContainer);
    if (!startBlock || !endBlock) return null;
    if (startBlock !== endBlock) return null; // spans more than one block

    const pre = document.createRange();
    pre.selectNodeContents(startBlock);
    try {
      pre.setEnd(range.startContainer, range.startOffset);
    } catch (e) {
      return null;
    }
    const before = pre.toString();
    const post = document.createRange();
    post.selectNodeContents(startBlock);
    try {
      post.setStart(range.endContainer, range.endOffset);
    } catch (e) {
      return null;
    }
    const after = post.toString();
    // slice by code points, so a surrogate pair is never cut in half
    const cut = (str, from, to) => Array.from(str).slice(from, to).join("");
    return { before: cut(before, -CTX_MAX), after: cut(after, 0, CTX_MAX) };
  }

  /** The selected contents themselves must be safe: no editor, no nested block. */
  function rangeContentsAreSafe(range) {
    let frag = null;
    try {
      frag = range.cloneContents();
    } catch (e) {
      return false;
    }
    if (!frag) return false;
    const editor = frag.querySelector(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
    );
    if (editor) return false;
    const block = frag.querySelector(
      "p, li, dd, dt, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre, div, section, article, main, table, tr",
    );
    if (block) return false;
    return true;
  }

  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const text = range.toString();
    if (!text || !text.trim()) return null;
    if (cpLen(text) > SEL_MAX) return { error: "too long" };

    const startEl = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : range.startContainer;
    const endEl = range.endContainer.nodeType === Node.TEXT_NODE
      ? range.endContainer.parentElement
      : range.endContainer;
    if (isEditableContext(startEl) || isEditableContext(endEl)) return { error: "editable" };
    if (inShadowRoot(startEl) || inShadowRoot(endEl)) return { error: "shadow" };

    const ctx = contextFor(range);
    if (!ctx) return { error: "multiblock" };
    if (!rangeContentsAreSafe(range)) return { error: "editable" };

    return { range: range.cloneRange(), text, before: ctx.before, after: ctx.after };
  }

  /** Is the saved selection still the one the reader made? */
  function stillValid(info) {
    if (!info || !info.range) return false;
    const r = info.range;
    if (!r.startContainer || !r.startContainer.isConnected) return false;
    if (!r.endContainer || !r.endContainer.isConnected) return false;
    try {
      if (r.toString() !== info.text) return false; // the text around it changed
    } catch (e) {
      return false;
    }
    return true;
  }

  /* ------------------------------------------------------------ live region */

  function ensureLiveRegion() {
    if (liveRegion && liveRegion.isConnected) return liveRegion;
    const el = document.createElement("div");
    el.setAttribute("aria-live", "polite");
    el.style.cssText =
      "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;";
    document.documentElement.appendChild(el);
    liveRegion = el;
    return el;
  }

  function announce(text) {
    const el = ensureLiveRegion();
    el.textContent = "";
    setTimeout(() => {
      el.textContent = text;
    }, 30);
  }

  /* -------------------------------------------------------------- the toast */

  /** A visible, extension-owned notice that does not touch the article. */
  function showToast(message, kind = "info") {
    removeToast();
    const host = document.createElement("div");
    host.setAttribute("data-stretch-toast", "");
    host.style.cssText =
      "position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:320px;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .box{font:12.5px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;
        background:${kind === "error" ? "#3d1418" : "#161b22"};
        border:1px solid ${kind === "error" ? "#f85149" : "#30363d"};
        color:#e6edf3;border-radius:8px;padding:10px 12px;
        box-shadow:0 4px 16px rgba(0,0,0,.4);display:flex;gap:8px;align-items:flex-start}
      button{all:unset;cursor:pointer;opacity:.6;margin-left:2px}
      button:hover{opacity:1}
    `;
    const box = document.createElement("div");
    box.className = "box";
    const txt = document.createElement("span");
    txt.textContent = message;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", removeToast);
    box.append(txt, close);
    shadow.append(style, box);
    document.documentElement.appendChild(host);
    toast = host;
    setTimeout(removeToast, kind === "error" ? 12000 : 6000);
  }

  function removeToast() {
    if (toast) {
      toast.remove();
      toast = null;
    }
  }

  /* --------------------------------------------------------- floating button */

  function removeFloatBtn() {
    if (floatBtn) {
      floatBtn.remove();
      floatBtn = null;
    }
  }

  function showFloatBtn(rect, onClick) {
    removeFloatBtn();
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      button{font:500 12px/1.2 -apple-system,"Segoe UI",system-ui,sans-serif;
        color:#0b1220;background:#8ab4f8;border:1px solid #1c3b6b;border-radius:999px;
        padding:4px 9px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);
        display:flex;align-items:center;gap:5px;white-space:nowrap}
      button:hover{background:#a9c7f8}
      button:focus-visible{outline:2px solid #1c3b6b;outline-offset:1px}
      .cost{opacity:.7;font-weight:400}
    `;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Stretch";
    const c = document.createElement("span");
    c.className = "cost";
    c.textContent = onClick.costLabel || "";
    btn.appendChild(c);
    btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the page selection
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick.click();
    });
    shadow.append(style, btn);
    document.documentElement.appendChild(host);
    // position:fixed is viewport-relative: no scroll offset here.
    const top = Math.max(4, Math.min(window.innerHeight - 44, rect.top - 34));
    const left = Math.min(window.innerWidth - 120, Math.max(4, rect.left));
    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    floatBtn = host;
    return btn;
  }

  /* -------------------------------------------------------------- selection */

  function onSelectionChange() {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      if (pending.size > 0) return; // do not steal the UI while a request runs
      const info = selectionInfo();
      if (!info) {
        savedInfo = null;
        removeFloatBtn();
        return;
      }
      if (info.error) {
        savedInfo = null;
        removeFloatBtn();
        if (info.error === "too long") {
          showToast("STRETCH: select up to 600 characters in one paragraph.", "error");
        } else if (info.error === "editable") {
          showToast("STRETCH does not touch editors or form fields.", "info");
        } else if (info.error === "multiblock") {
          showToast("STRETCH: select text inside one paragraph.", "error");
        }
        return;
      }
      savedInfo = info;
      const rect = info.range.getBoundingClientRect();
      showFloatBtn(rect, {
        costLabel: "",
        click: () => startStretch(),
      });
    }, 120);
  }

  function onMouseDown(e) {
    if (floatBtn && e.target) {
      const path = e.composedPath ? e.composedPath() : [e.target];
      const inBtn = path.includes(floatBtn) || (floatBtn.contains && floatBtn.contains(e.target));
      if (!inBtn) removeFloatBtn();
    }
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      removeFloatBtn();
      savedInfo = null;
    }
  }

  /* --------------------------------------------------------------- the host */

  function hostStyles() {
    return `
      :host{display:inline;font:inherit;color:inherit;line-height:inherit}
      .add{font:inherit;opacity:.92}
      .add::before{content:" ("}
      .add::after{content:")"}
      .minus{all:unset;cursor:pointer;margin-left:3px;padding:0 4px;border-radius:4px;
        font:inherit;font-size:.9em;opacity:.55;border:1px solid currentColor;line-height:1.1}
      .minus:hover{opacity:1}
      .minus:focus-visible{outline:2px solid currentColor;opacity:1}
      .cached{font-size:.8em;opacity:.5;margin-left:3px}
      .cost{font-size:.8em;opacity:.45;margin-left:4px}
      .err{font:inherit;font-size:.9em;opacity:.7}
      .loading{font:inherit;font-size:.9em;opacity:.6}
    `;
  }

  function makeHost(anchorId) {
    const host = document.createElement("span");
    host.setAttribute(HOST_ATTR, anchorId);
    host.style.cssText = "display:inline;font:inherit;color:inherit;line-height:inherit;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = hostStyles();
    shadow.appendChild(style);
    return { host, shadow };
  }

  function insertAt(range, node) {
    const r = range.cloneRange();
    r.collapse(false); // end of the selection
    r.insertNode(node);
    return r;
  }

  function removeHost(hostEl, anchorId) {
    if (hostEl && hostEl.isConnected) hostEl.remove();
    hosts.delete(anchorId);
  }

  /** Remove every addition this extension made in this document. */
  function removeAll() {
    // cancel anything still running so it cannot keep billing
    for (const [requestId, p] of Array.from(pending.entries())) {
      try {
        chrome.runtime.sendMessage({ v: 1, type: "STRETCH_CANCEL", requestId });
      } catch (e) {
        /* the worker may be gone */
      }
      pending.delete(requestId);
      if (p.host && p.host.isConnected) p.host.remove();
    }
    for (const [anchorId, el] of Array.from(hosts.entries())) {
      if (el && el.isConnected) el.remove();
      hosts.delete(anchorId);
    }
    announce("All STRETCH additions removed.");
  }

  function renderAddition(hostEl, shadow, { text, model, cost, cached }) {
    shadow.querySelectorAll(".add,.minus,.cached,.cost,.err,.loading").forEach((n) => n.remove());
    const add = document.createElement("span");
    add.className = "add";
    add.textContent = text; // plain text node, never HTML
    const minus = document.createElement("button");
    minus.className = "minus";
    minus.type = "button";
    minus.textContent = "×";
    minus.title = "Shrink this addition";
    minus.setAttribute("aria-label", "Shrink this addition");
    minus.addEventListener("mousedown", (e) => e.preventDefault());
    minus.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeHost(hostEl, hostEl.getAttribute(HOST_ATTR) || "");
      announce("Addition removed.");
    });
    shadow.append(add, minus);
    if (cached) {
      const c = document.createElement("span");
      c.className = "cached";
      c.textContent = "Cached · no new request";
      shadow.appendChild(c);
      setTimeout(() => c.remove(), 4000);
    }
    if (cost !== null && cost !== undefined) {
      const c = document.createElement("span");
      c.className = "cost";
      c.textContent = `estimated cost ${cost.toFixed(6)} Pollen`;
      shadow.appendChild(c);
    }
    announce(cached ? "Cached addition restored." : "Addition inserted.");
  }

  /* ------------------------------------------------------------ the request */

  async function startStretch() {
    if (!savedInfo) return;
    const info = savedInfo;
    removeFloatBtn();

    // Never stretch our own generated text.
    const el = info.range.startContainer.nodeType === Node.TEXT_NODE
      ? info.range.startContainer.parentElement
      : info.range.startContainer;
    if (el && el.closest && el.closest(`[${HOST_ATTR}]`)) return;

    const key = cacheKey(info);
    const anchorId = newAnchorId();

    // The reader may have changed the text since the button appeared.
    if (!stillValid(info)) {
      showToast("STRETCH: the text changed — select it again.", "error");
      return;
    }

    // Cached? Re-insert without spending anything. A hash hit is confirmed by
    // comparing the exact fields: two different contexts must never share a key.
    const hit = cache.get(key);
    if (hit && hit.selection === info.text && hit.before === info.before && hit.after === info.after) {
      const { host, shadow } = makeHost(anchorId);
      try {
        insertAt(info.range, host);
      } catch (e) {
        announce("The page changed; the cached addition was discarded.");
        return;
      }
      hosts.set(anchorId, host);
      renderAddition(host, shadow, { text: hit.text, model: hit.model, cost: hit.cost, cached: true });
      return;
    }

    const { host, shadow } = makeHost(anchorId);
    try {
      insertAt(info.range, host);
    } catch (e) {
      announce("Could not insert here.");
      return;
    }
    hosts.set(anchorId, host);

    const loading = document.createElement("span");
    loading.className = "loading";
    loading.textContent = " …";
    const cancel = document.createElement("button");
    cancel.className = "minus";
    cancel.type = "button";
    cancel.textContent = "×";
    cancel.title = "Cancel this request";
    cancel.setAttribute("aria-label", "Cancel this request");
    cancel.addEventListener("mousedown", (e) => e.preventDefault());
    shadow.append(loading, cancel);
    announce("Stretching…");

    const requestId = `r${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
    const controller = { aborted: false };
    pending.set(requestId, { anchorId, host, shadow, controller });

    cancel.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      controller.aborted = true;
      try {
        chrome.runtime.sendMessage({ v: 1, type: "STRETCH_CANCEL", requestId });
      } catch (_) {
        /* the worker may be gone; the local host is removed anyway */
      }
      removeHost(host, anchorId);
      pending.delete(requestId);
      announce("Cancelled. The provider may still have billed the request.");
    });

    let res;
    try {
      res = await chrome.runtime.sendMessage({
        v: 1,
        type: "STRETCH_REQUEST",
        requestId,
        anchorId,
        documentId: DOC_ID,
        selection: info.text,
        before: info.before,
        after: info.after,
      });
    } catch (e) {
      res = {
        ok: false,
        error: { code: "PROVIDER_ERROR", message: "STRETCH could not reach its background worker." },
      };
    }
    pending.delete(requestId);
    if (controller.aborted) return;
    if (!host.isConnected) return; // the host was removed while we waited
    // The page may have rewritten the text while we waited: do not insert an
    // answer that no longer matches the sentence.
    if (!stillValid(info)) {
      removeHost(host, anchorId);
      showToast("STRETCH: the text changed while I was writing — the answer was discarded.", "error");
      announce("The page changed; the answer was discarded.");
      return;
    }

    if (!res || !res.ok) {
      const err = (res && res.error) || { code: "PROVIDER_ERROR", message: "Something went wrong." };
      // Leave no trace in the author's paragraph; report it visibly instead.
      removeHost(host, anchorId);
      const msg = err.message || "Something went wrong.";
      showToast(`STRETCH: ${msg}`, "error");
      announce(`Stretch failed: ${msg}`);
      return;
    }
    const entry = {
      text: res.body,
      model: res.model,
      cost: res.estimatedPollen,
      selection: info.text,
      before: info.before,
      after: info.after,
    };
    cache.set(key, entry);
    renderAddition(host, shadow, { text: entry.text, model: entry.model, cost: entry.cost, cached: false });
  }

  /* ----------------------------------------------------------------- wiring */

  document.addEventListener("selectionchange", onSelectionChange, { passive: true });
  document.addEventListener("mousedown", onMouseDown, { passive: true });
  document.addEventListener("keydown", onKeyDown, { passive: true });

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "STRETCH_REMOVE_ALL") {
        removeAll();
        sendResponse({ ok: true });
        return false;
      }
      return false;
    });
  }
})();
