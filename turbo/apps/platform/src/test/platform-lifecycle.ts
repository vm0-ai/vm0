import indexHtml from "../../index.html?raw";

type InlineLifecycle = (
  window: Window,
  controller: typeof AbortController,
) => void;

const page = new DOMParser().parseFromString(indexHtml, "text/html");
const source = page.querySelector("[data-okou-lifecycle]")?.textContent;
if (!source) {
  throw new Error("index.html is missing the platform lifecycle script");
}
const runLifecycle = new Function(
  "window",
  "AbortController",
  source,
) as InlineLifecycle;

/** Runs the deployed HTML script, with document disposal owned by the test. */
export function installPlatformLifecycle(signal: AbortSignal): void {
  signal.throwIfAborted();
  const platformWindow = window;
  class DocumentAbortController extends AbortController {
    constructor() {
      super();
      signal.addEventListener(
        "abort",
        () => {
          this.abort(signal.reason);
        },
        { once: true },
      );
    }
  }
  runLifecycle(platformWindow, DocumentAbortController);
  signal.addEventListener(
    "abort",
    () => {
      delete platformWindow._okou;
    },
    { once: true },
  );
}
