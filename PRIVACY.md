# Privacy — STRETCH

STRETCH is a personal reading aid. It is designed so that the minimum possible
information leaves your browser.

## What is sent to Pollinations

When you click **Stretch**, exactly one request is made:

```json
{
  "selection": "the phrase you selected",
  "before": "up to 1000 characters before the selection, same paragraph",
  "after": "up to 1000 characters after the selection, same paragraph"
}
```

That JSON is the body of a `POST https://gen.pollinations.ai/v1/chat/completions`
call, together with a fixed system prompt and the model id.

**Never sent:** the page URL, the page HTML, cookies, other tabs, browsing
history, your Pollen account email, or any identifier.

## What is stored, and where

| Data | Where | Lifetime |
|---|---|---|
| Your Pollinations `sk_…` key | `chrome.storage.local` (your browser profile) | Until you disconnect or it expires (keys normally expire after 7 days) |
| Your chosen model | `chrome.storage.local` | Until you change it |
| Model price sheet | `chrome.storage.local` | Refreshed on connect |
| Device code during sign-in | `chrome.storage.session` | Until sign-in finishes, expires, or the tab closes |
| Generated additions | The page itself (inline), and an in-memory cache in the tab | Until you remove them or close the tab |

* The token is **not** in `localStorage`, not in the page, not in a URL, not in
  analytics, and not written to the console.
* `chrome.storage.local` is not an encrypted vault. The key is protected from
  ordinary page JavaScript, not from someone who controls your machine.
* The service worker is the only component that can read the key. The content
  script never receives it.

## What the site can see

A generated addition is inserted into the page's DOM. **That site can read it**
and can remove it. Shadow DOM is not a confidentiality boundary. If a page
rewrites its own DOM under the cursor, STRETCH cancels the pending result
rather than inserting text in the wrong place.

## No telemetry

STRETCH has no analytics, no crash reporting, no update pings and no user
tracking. The only network requests it ever makes are:

1. `POST https://enter.pollinations.ai/api/device/code` and
   `POST https://enter.pollitations.ai/api/device/token` — sign-in only.
2. `GET https://gen.pollinations.ai/v1/models` — to read prices and check that
   a model is tier-eligible.
3. `POST https://gen.pollinations.ai/v1/chat/completions` — one per stretch you
   asked for.

## Your control

* **Disconnect** (popup) removes the stored key from this browser.
* Revoking the key at Pollinations invalidates it everywhere.
* **Remove all** (popup) removes every addition STRETCH inserted in the current
  page.
* Closing the browser removes the in-memory cache.

## Contact

Questions about this extension: open an issue in the repository.
