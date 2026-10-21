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
 */
(() => {
  if (window.__stretchLoaded) return;
  window.__stretchLoaded = true;

  const HOST_ATTR = "data-stretch-host";
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
    const sel = String(info.selection || "").trim();
    const b = String(info.before || "").trim().slice(-200);
    const a = String(info.after || "").trim().slice(0, 200);
    return `k${hashString(sel + " " + b + " " + a)}`;
  }

  /** key -> { text, model, cost } for results that were already paid for. */
  const cache = new Map();
  /** key -> host element currently in the page. */
  const hosts = new Map();
  /** requestId -> { key, host, shadow } */
  const pending = new Map();

  let savedInfo = null;
  let floatBtn = null;
  let liveRegion = null;
  let selTimer = null;

  /* ------------------------------------------------------------- utilities */

  const cpLen = (s) => Array.from(String(s || "")).length;

  /** The block element that owns a node (never an inline element). */
  function blockOf(node) {
    let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      const display = window.getComputedStyle(el).display;
      if (display !== "inline" && display !== "inline-block" && display !== "contents") {
        // a block container that is not the whole document body
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
    return { before: before.slice(-CTX_MAX), after: after.slice(0, CTX_MAX) };
  }

  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const text = range.toString();
    if (!text || !text.trim()) return null;
    if (cpLen(text) > SEL_MAX) return { error: "unsupported" };

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

    return { range, text, before: ctx.before, after: ctx.after };
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
      if (!info || info.error) {
        savedInfo = null;
        removeFloatBtn();
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

  function makeHost(key) {
    const host = document.createElement("span");
    host.setAttribute(HOST_ATTR, key);
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

  function removeHost(hostEl, key) {
    if (hostEl && hostEl.isConnected) hostEl.remove();
    hosts.delete(key);
  }

  function removeAll() {
    for (const [key, el] of Array.from(hosts.entries())) {
      removeHost(el, key);
    }
    hosts.clear();
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
      const key = hostEl.getAttribute(HOST_ATTR) || "";
      removeHost(hostEl, key);
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
      c.textContent = `~${cost.toFixed(6)} Pollen`;
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

    // Cached? Re-insert without spending anything.
    const hit = cache.get(key);
    if (hit) {
      const { host, shadow } = makeHost(key);
      try {
        insertAt(info.range, host);
      } catch (e) {
        announce("The page changed; the cached addition was discarded.");
        return;
      }
      hosts.set(key, host);
      renderAddition(host, shadow, { text: hit.text, model: hit.model, cost: hit.cost, cached: true });
      return;
    }

    const { host, shadow } = makeHost(key);
    try {
      insertAt(info.range, host);
    } catch (e) {
      announce("Could not insert here.");
      return;
    }
    hosts.set(key, host);

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
    cancel.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ v: 1, type: "STRETCH_CANCEL", requestId });
      } catch (_) {
        /* the worker may be gone; the local host is removed anyway */
      }
      removeHost(host, key);
      pending.delete(requestId);
      announce("Cancelled. The provider may still have billed the request.");
    });
    shadow.append(loading, cancel);
    announce("Stretching…");

    const requestId = `r${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
    pending.set(requestId, { key, host, shadow });

    let res;
    try {
      res = await chrome.runtime.sendMessage({
        v: 1,
        type: "STRETCH_REQUEST",
        requestId,
        anchorId: key,
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
    if (!host.isConnected) return; // the host was removed while we waited

    if (!res || !res.ok) {
      const err = (res && res.error) || { code: "PROVIDER_ERROR", message: "Something went wrong." };
      // Leave no trace in the author's paragraph: report through the live region.
      removeHost(host, key);
      announce(`Stretch failed: ${err.message || "Something went wrong."}`);
      return;
    }
    const entry = { text: res.body, model: res.model, cost: res.estimatedPollen };
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
