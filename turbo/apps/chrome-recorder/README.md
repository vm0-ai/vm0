# Okou Screen Recorder

Manifest V3 Chrome extension that records a browser tab with Okou's controls
rendered inside the page being recorded.

## Local build

```bash
pnpm --dir turbo --filter @okouai/chrome-recorder build
```

Load `turbo/apps/chrome-recorder/dist` from `chrome://extensions` with **Load
unpacked**.

## User flow

1. Click the Okou toolbar action.
2. The extension checks the Okou sign-in state through the `__session` and
   `__client_uat` cookies on the Okou origin. When no session exists it opens
   `app.okou.ai` and marks the action; sign in and click the action again.
3. Chrome's native share picker opens. Only the **Chrome Tab** surface is
   accepted — window and full-screen capture are refused, because the page
   controls and DOM blur exist only inside a tab.
4. The chosen page shows the ready panel: microphone, tab audio, **Blur
   elements**, and **Start recording**.
5. **Start recording** runs a `3 · 2 · 1` countdown inside the page. Capture
   begins only after it finishes, so the countdown never lands in the file.
6. The recording controller stays in the page: elapsed time, pause, resume,
   finish, and discard. Chrome's own **Stop sharing** finishes immediately.
7. The finished WebM is written to the extension's IndexedDB, a new Okou tab
   opens with `?okouRecorderSession=<id>`, and the recording is handed to the
   application. The extension copy is deleted once the application acknowledges
   it.

## Architecture

| Context            | File                    | Responsibility                                                               |
| ------------------ | ----------------------- | ---------------------------------------------------------------------------- |
| Service worker     | `src/service-worker.ts` | Sign-in check, session state, tab routing, opening the Okou handoff tab      |
| Offscreen document | `src/offscreen.ts`      | `getDisplayMedia`, microphone mixing, `MediaRecorder`, storing the result    |
| Content script     | `src/content.ts`        | Overlay lifecycle in the recorded tab, handoff bridge on the Okou tab        |
| Overlay            | `src/overlay.ts`        | Ready panel, blur mode, countdown, recording controller                      |
| Blur               | `src/blur-manager.ts`   | Element selection and blur persistence                                       |
| Handoff frame      | `src/handoff.ts`        | Reads the recording from extension IndexedDB and posts it to the application |

Capture lives in the offscreen document rather than the content script so the
stream and `MediaRecorder` survive navigation inside the recorded tab.

## Element blur

Blur is applied to the pixels before they reach `MediaRecorder`, so the video
file itself is redacted; there is no post-processing step and no unblurred copy.

Selecting an element sets an inline `filter: blur(10px) !important` on that
element, so the blur travels with it while the page scrolls. Pages also destroy
and rebuild those nodes — virtualized lists, infinite scroll, SPA re-renders —
so each selection additionally stores a selector, preferring `id` and stable
test/ARIA attributes and falling back to a structural path. A `MutationObserver`
on `childList`, `style`, and `class`, plus a capture-phase `scroll` listener,
re-applies the blur to every current match and drops detached nodes.

Known limits: the extension cannot reach `chrome://` pages, the Chrome Web
Store, or native applications, and elements rendered inside a single `canvas` or
`<video>` cannot be selected individually.

## Application handoff

`packages/core/src/browser-recorder-protocol.ts` holds the contract shared with
the Okou application. The recording lives in extension-origin IndexedDB, which
page scripts cannot read, so `handoff.html` is loaded as a hidden
extension-origin iframe and the content script relays structured-clone messages
between it and the application:

1. Application → `handoff:ready`
2. Extension → `handoff:recording` (or `handoff:error`)
3. Application → `handoff:complete`, after which the extension deletes its copy

The application side of this exchange — receiving `handoff:recording`, opening
the source dialog, and uploading — is not implemented yet.

## Verification

`pnpm --dir turbo --filter @okouai/chrome-recorder test` covers the blur manager
and the overlay state machine in `happy-dom`.

Verified by hand in Chromium 151 with the unpacked build loaded: the service
worker starts, `chrome.cookies` reads the Okou sign-in state with no Okou tab
open, `getDisplayMedia` succeeds from the offscreen document without a user
gesture, the ready panel renders in the recorded page, clicking an element
blurs it, the blur re-applies to a recycled node after a scroll re-render, and
the countdown sends `start` to the service worker.

Not verified: headless Chromium resolves every `getDisplayMedia` call to a
synthetic monitor, so the `displaySurface === "browser"` guard that refuses
non-tab capture has not been exercised against a real tab selection.
