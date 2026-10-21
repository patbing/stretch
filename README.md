# STRETCH

**Stretchtext for any web page.** Select a phrase, click **Stretch**, and the
sentence grows a short inline addition right where you were reading — then
**−** shrinks it back. You pay with your own Pollen.

[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

> In 1967 Ted Nelson described text that *grows* where the reader wants more and
> *shrinks back* where they don't. Writing every level by hand was too much
> work, so it never caught on. Generated text makes it cheap.

Quest: [pollinations/pollinations#17998](https://github.com/pollinations/pollinations/issues/17998)

---

## Install (unpacked, no store)

1. Download `stretch-0.1.0.zip` from the [install page](https://patbing.github.io/stretch/).
2. Extract it.
3. Open `chrome://extensions` → enable **Developer mode**.
4. Choose **Load unpacked** and select the folder that contains `manifest.json`.
5. Pin **STRETCH**, open the popup and choose **Connect your Pollen**.
6. Open a page, click **Enable on this page**, select a phrase, click **Stretch**.

No build step, no dependencies, no account of ours. The ZIP contains only the
extension source.

## What it does

| Step | What happens |
|---|---|
| You select a phrase (1–600 characters, one paragraph) | A small **Stretch** button appears next to the selection |
| You click it | The phrase's sentence grows an inline addition in the page, in the page's own font |
| You click **−** | The addition disappears; the original wording is untouched |
| You click **Stretch** again | The cached addition comes back — **no new request, no new cost** |

The original text is never rewritten or wrapped. STRETCH appends one
extension-owned inline element at the end of the selection and removes exactly
that element on shrink.

## Models and cost

Only two models are ever called, and both are usable with **Quest (tier)
Pollen** — so a reader who has never paid anything can try it:

| Name | Model id | Input / 1M | Output / 1M | Measured |
|---|---|---:|---:|---|
| **Nano** (default) | `openai/gpt-5.4-nano` | 0.15 Pollen | 0.9375 Pollen | ~2–13 s, never truncates |
| **Flash** | `deepseek/deepseek-v4.1-flash` | 0.15 Pollen | 0.60 Pollen | ~9–22 s (it reasons first), richest prose |

A typical stretch (≈1,500 input + 400 output tokens) costs **≈0.0005 Pollen**;
a heavy one (≈9,000 input tokens) is **≈0.0016 Pollen**. The popup shows the
estimate, and the exact figure from the reported usage is shown after each
call. Cached re-expansions make no request at all.

The model choice was measured, not guessed: on the real prompt and 20 fixed
selections, `gpt-5.4-nano` returned a usable, in-language, context-compatible
addition in **20/20** cases; `deepseek-v4.1-flash` is slower because it
spends its token budget reasoning first (at a 400-token cap it returned
*empty* content — the cap is now 1,200).

Prices are read from `GET /v1/models` when you connect, and the extension
refuses to surface a model that is not tier-eligible.

## Your Pollen, your key

STRETCH never holds a shared key and never proxies your traffic.

1. The popup opens a **Connect your Pollen** tab.
2. That tab requests a device code from Pollinations and shows it.
3. **Authorize at Pollinations** opens `enter.pollinations.ai/device` in a normal tab.
4. The tab polls every 5 s until you approve; the service worker stores the
   `sk_…` key in `chrome.storage.local`.

* The key is stored in your browser profile's local extension storage. It is
  protected from page JavaScript, **not** encrypted at rest.
* Authorized keys normally expire after 7 days and can be revoked sooner.
* **Disconnect** in the popup clears the local key. To invalidate it
  everywhere, revoke it at Pollinations.
* The key is never sent to the content script, never placed in the page, never
  written to `localStorage`, and never included in a log.

## Privacy

* The request contains **only** the selected text plus up to 1,000 characters
  of context from the same paragraph before and after it.
* No URL, no page HTML, no cookies, no telemetry, no error reporting uploads.
* Generated additions are inserted into the page, so **the site can see them**.
  Shadow DOM is not a confidentiality guarantee.
* See [PRIVACY.md](PRIVACY.md).

## Known limits (v1, on purpose)

* Top-level document only — iframes and shadow DOM are not supported.
* Selections must stay inside one paragraph. Editors, inputs and textareas are
  never modified.
* No Firefox build, no store listing, no sync, no account system, no telemetry.
* "Works on any page" means "works across ordinary websites" — browser-internal
  pages (`chrome://`, the Web Store, PDF viewer) block extensions by design.

## Development

```bash
npm test            # node --test  — 27 unit tests, no dependencies
python tools/make_icons.py   # regenerate icons/ (stdlib only)
```

The extension is plain JavaScript with no bundler and no framework:
`manifest.json`, `background.js` (service worker — owns the key and the API
calls), `content.js` (the only file that touches the page), `popup.*`,
`connect.*`, and `lib/` (pure, unit-tested prompt and validation logic).

## License

MIT
