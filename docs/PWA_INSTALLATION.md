# Installing as an App (PWA)

Billbook installs from the browser. There is no APK, no app store, and no
separate build — the same site is used either way, and the app is a normal
website first.

---

## Why install it

Installed, it opens from a home-screen or desktop icon with no browser chrome,
launches faster, keeps working as a real app window on a desktop, and does not
show an address bar that an employee could wander out of.

---

## Android — Chrome, Edge, Samsung Internet

The app shows an **Install** banner on first visit. Tap it.

If the banner was dismissed, open the browser menu and choose **Install app** or
**Add to Home screen**. The exact wording varies by browser version.

> The banner requires Chrome to consider the app installable: served over
> **HTTPS**, a valid manifest, and a service worker that has activated. On
> `http://localhost` this works; on a plain `http://` address on a LAN it will
> not, and no amount of browser-menu fiddling will change that.

## iPhone and iPad — Safari

**Safari only.** Chrome on iOS cannot install web apps.

1. Tap **Share** (the square with an arrow pointing up).
2. Scroll to **Add to Home Screen**.
3. Tap **Add**.

## Desktop — Chrome, Edge, Brave

- Click the install icon at the right of the address bar, or
- **⋮ → Cast, save and share → Install page as app**.

## Desktop — Firefox, Safari

No installation is offered. The application works fully as a website; only the
standalone window and the offline shell are unavailable. Nothing is lost.

---

## What the install actually gives you

| Works offline | Needs a connection |
| --- | --- |
| Opening the app | Every screen that reads data |
| Moving between screens | Saving anything at all |
| Navigation and menus | Signing in |
| Printing a document already on screen | Camera capture for OCR |
| | Generating a PDF file |

The app tells you when you are offline: a banner appears above the top bar and
the status dot turns amber.

**Saving is online-only by design.** A challan queued while offline and synced
later could be submitted twice and create a duplicate record. A duplicate
material movement cannot be undone by editing a number, so the system does not
offer offline entry at all.

---

## How updates work

The app checks for a new version when you open it. If one is ready, a green
banner appears: **"A new version of the app is ready."**

Tap **Update now** to switch. Tap **✕** to stay on the current version — it will
not ask again about that particular build, but it will ask about the next one.

Updates are **never** applied silently. A worker that swapped itself in
automatically could replace the code underneath a challan form you were halfway
through filling in, and lose what you typed.

---

## Uninstalling

- **Android / desktop:** long-press the icon, or right-click it, and choose
  **Uninstall** / **Remove**.
- **iOS:** long-press the icon → **Delete App** → **Delete**.

Removing the app does not delete any business data — everything lives in the
database. If a shared device is being cleared, remove each employee's access
from **Settings → Employee access** first. That matters, because the browser
cache on the device survives the app being removed.

---

## Troubleshooting

**No install banner appears.**
Check all of:

- The site is served over **HTTPS** (`http://localhost` is exempt).
- The manifest is reachable at `/manifest.webmanifest`.
- A service worker is active: DevTools → **Application → Service Workers**.
- The app has been opened over HTTPS at least once.

**"Install app" is missing from the browser menu.**
Chrome hides it when it does not consider the app installable, or after you have
dismissed the prompt repeatedly. Dismissals are per-origin and reset by clearing
site data.

**It installed but opens in a browser tab with an address bar.**
The `display` mode is `standalone` in the manifest, so this usually means a
stale cached copy of the manifest. Remove the app, clear site data, reopen.

**Offline opens the app but every screen says "connection failed".**
Correct behaviour. The shell is cached; your business data is not, by design.

**The update banner never appears.**
Forced by an old worker:

```bash
# In DevTools → Application → Service Workers: check "Update on reload"
# Or unregister the worker and hard-reload.
```

**Installation looks broken after a deploy.**
`sw.js` must not be cached. Serve it with `Cache-Control: no-cache`, and set
`Service-Worker-Allowed: /`. See `docs/DEPLOYMENT.md`.

---

## Verifying a deployment

```bash
npm run build
npm run verify:pwa
```

This checks that the manifest is valid, every icon exists and is a real PNG, both
192 and 512 sizes are declared, a maskable icon is present, the worker has a
navigation fallback, the HTML links the manifest and carries the mobile viewport
and theme-colour tags — and, most importantly, that **no authenticated response
can be cached**. The check is proven to fail if a runtime-caching route for the
data API is introduced.