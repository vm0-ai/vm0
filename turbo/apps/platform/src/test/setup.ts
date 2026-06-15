import "@testing-library/jest-dom/vitest";
import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
  indexedDB,
} from "fake-indexeddb";
import { server } from "../mocks/server.ts";
import { afterAll, afterEach, beforeEach, beforeAll, vi } from "vitest";
import { mockedClerk } from "../__tests__/mock-auth.ts";
import { clearAllDetached } from "../signals/utils.ts";

vi.mock("@clerk/clerk-js", () => {
  return {
    Clerk: function MockClerk() {
      return mockedClerk;
    },
  };
});

vi.hoisted(() => {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "test_key");
  vi.stubEnv("VITE_API_URL", "http://localhost:3000");
  vi.stubEnv("VITE_ZERO_HOST_DOMAIN", "sites.vm7.io");
});

globalThis.indexedDB = indexedDB;
globalThis.IDBCursor = IDBCursor;
globalThis.IDBCursorWithValue = IDBCursorWithValue;
globalThis.IDBDatabase = IDBDatabase;
globalThis.IDBFactory = IDBFactory;
globalThis.IDBIndex = IDBIndex;
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.IDBObjectStore = IDBObjectStore;
globalThis.IDBOpenDBRequest = IDBOpenDBRequest;
globalThis.IDBRequest = IDBRequest;
globalThis.IDBTransaction = IDBTransaction;
globalThis.IDBVersionChangeEvent = IDBVersionChangeEvent;

type HappyDomAttributeCallback = (
  this: HTMLIFrameElement,
  attribute: Attr,
  replacedAttribute: Attr | null,
) => void;

type HappyDomLifecycleCallback = (this: HTMLIFrameElement) => void;

type PatchedHTMLIFrameElementPrototype = HTMLIFrameElement &
  Record<symbol, unknown> & {
    vm0HappyDomIframeLoadPatched?: true;
  };

type StderrWriteArgs = [
  chunk: string | Uint8Array,
  encodingOrCallback?: string | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void,
];

type StderrWrite = (...args: StderrWriteArgs) => boolean;

type PatchedStderr = {
  write: StderrWrite;
  vm0OriginalWrite?: StderrWrite;
  vm0HappyDomIframeNoisePatched?: true;
};

const nodeProcess = (
  globalThis as typeof globalThis & {
    process: { stderr: PatchedStderr };
  }
).process;

function findPrototypeSymbol(
  prototype: object,
  description: string,
): symbol | undefined {
  return Object.getOwnPropertySymbols(prototype).find((symbol) => {
    return symbol.description === description;
  });
}

function installHappyDomIframeLoadPatch(): void {
  const iframePrototype =
    HTMLIFrameElement.prototype as PatchedHTMLIFrameElementPrototype;
  if (iframePrototype.vm0HappyDomIframeLoadPatched) {
    return;
  }

  const htmlElementPrototype = Object.getPrototypeOf(iframePrototype) as Record<
    symbol,
    unknown
  >;
  const onSetAttributeSymbol = findPrototypeSymbol(
    iframePrototype,
    "onSetAttribute",
  );
  const onRemoveAttributeSymbol = findPrototypeSymbol(
    iframePrototype,
    "onRemoveAttribute",
  );
  const connectedToDocumentSymbol = findPrototypeSymbol(
    iframePrototype,
    "connectedToDocument",
  );

  if (
    !onSetAttributeSymbol ||
    !onRemoveAttributeSymbol ||
    !connectedToDocumentSymbol
  ) {
    iframePrototype.vm0HappyDomIframeLoadPatched = true;
    return;
  }

  const originalOnSetAttribute = iframePrototype[
    onSetAttributeSymbol
  ] as HappyDomAttributeCallback;
  const originalOnRemoveAttribute = iframePrototype[
    onRemoveAttributeSymbol
  ] as (this: HTMLIFrameElement, removedAttribute: Attr) => void;
  const originalConnectedToDocument = iframePrototype[
    connectedToDocumentSymbol
  ] as HappyDomLifecycleCallback;
  const htmlElementOnSetAttribute = htmlElementPrototype[
    onSetAttributeSymbol
  ] as HappyDomAttributeCallback;
  const htmlElementOnRemoveAttribute = htmlElementPrototype[
    onRemoveAttributeSymbol
  ] as (this: HTMLIFrameElement, removedAttribute: Attr) => void;
  const htmlElementConnectedToDocument = htmlElementPrototype[
    connectedToDocumentSymbol
  ] as HappyDomLifecycleCallback;

  iframePrototype[onSetAttributeSymbol] = function onSetAttributeWithoutLoad(
    this: HTMLIFrameElement,
    attribute: Attr,
    replacedAttribute: Attr | null,
  ): void {
    if (attribute.name === "src" && !this.hasAttribute("srcdoc")) {
      htmlElementOnSetAttribute.call(this, attribute, replacedAttribute);
      return;
    }
    originalOnSetAttribute.call(this, attribute, replacedAttribute);
  };

  iframePrototype[onRemoveAttributeSymbol] =
    function onRemoveAttributeWithoutLoad(
      this: HTMLIFrameElement,
      removedAttribute: Attr,
    ): void {
      if (
        (removedAttribute.name === "src" ||
          removedAttribute.name === "srcdoc") &&
        !this.hasAttribute("srcdoc")
      ) {
        htmlElementOnRemoveAttribute.call(this, removedAttribute);
        return;
      }
      originalOnRemoveAttribute.call(this, removedAttribute);
    };

  iframePrototype[connectedToDocumentSymbol] =
    function connectedToDocumentWithoutExternalLoad(
      this: HTMLIFrameElement,
    ): void {
      if (!this.hasAttribute("srcdoc")) {
        htmlElementConnectedToDocument.call(this);
        return;
      }
      originalConnectedToDocument.call(this);
    };

  iframePrototype.vm0HappyDomIframeLoadPatched = true;
}

installHappyDomIframeLoadPatch();

const originalStderrWrite =
  nodeProcess.stderr.vm0OriginalWrite ??
  nodeProcess.stderr.write.bind(nodeProcess.stderr);

function isDisabledIframePageLoadingLog(chunk: string | Uint8Array): boolean {
  const text =
    typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  return (
    text.includes("DOMException [NotSupportedError]") &&
    text.includes("Iframe page loading is disabled")
  );
}

function writeStderrWithoutHappyDomIframeNoise(
  ...args: StderrWriteArgs
): boolean {
  const [chunk] = args;
  if (isDisabledIframePageLoadingLog(chunk)) {
    return true;
  }
  return originalStderrWrite(...args);
}

if (!nodeProcess.stderr.vm0HappyDomIframeNoisePatched) {
  nodeProcess.stderr.vm0OriginalWrite = originalStderrWrite;
  nodeProcess.stderr.write = writeStderrWithoutHappyDomIframeNoise;
  nodeProcess.stderr.vm0HappyDomIframeNoisePatched = true;
}

function ensureTestLocalStorage(): void {
  const currentLocalStorage = globalThis.localStorage;
  if (
    typeof currentLocalStorage !== "undefined" &&
    typeof currentLocalStorage.getItem === "function" &&
    typeof currentLocalStorage.setItem === "function"
  ) {
    return;
  }
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear: () => {
        values.clear();
      },
      getItem: (key: string) => {
        return values.get(key) ?? null;
      },
      key: (index: number) => {
        return Array.from(values.keys())[index] ?? null;
      },
      get length() {
        return values.size;
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    } satisfies Storage,
  });
}

// vitest.config.ts sets disableIframePageLoading: true so happy-dom does not
// make real TCP connections when an iframe src is set to an external URL.
// happy-dom logs the NotSupportedError to its virtual console before emitting
// an iframe error event; Vitest forwards that virtual-console error to stderr.
// Keep the stderr filter narrowly scoped so other test errors stay visible.
// happy-dom dispatches the resulting NotSupportedError as a window error event
// (not console.error), which vitest would re-emit as process.uncaughtException
// and fail the test run. This listener suppresses that specific error.
window.addEventListener("error", (event) => {
  if (
    event.error instanceof DOMException &&
    event.error.message.includes("Iframe page loading is disabled")
  ) {
    event.preventDefault();
  }
});

beforeAll(() => {
  // Disable CSS animations/transitions so Radix UI dialog open/close
  // does not wait for animation frames to settle in act().
  const style = document.createElement("style");
  style.textContent =
    "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; animation-delay: 0s !important; }";
  document.head.appendChild(style);

  server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  ensureTestLocalStorage();

  // Override console.error to throw on unexpected errors.
  // - NotSupportedError / AbortError: expected happy-dom noise, silently ignored.
  // - "not wrapped in act(...)": unavoidable with our async bootstrap pattern
  //   (render() runs inside act, then route setup updates page$ outside act).
  //   Silently ignored.
  // - "suspended inside an `act` scope, but the `act` call was not awaited":
  //   React 19 variant of the same problem — timer-driven detached signals
  //   (polling, fire-and-forget DOM commands) commit after the test scope
  //   has closed. Same root cause as the "not wrapped in act" filter above.
  // - "Detached promise rejected": detach()'s bookkeeping log for non-abort
  //   rejections from DOM-callback flows. The UI surfaces these via toast;
  //   the log is for dev-console visibility, not a test assertion. Silently
  //   ignored so tests can assert on toast/dialog behaviour without needing
  //   to swallow the same rejection at the call site.
  // - Everything else: thrown so real problems surface early.
  vi.spyOn(console, "error").mockImplementation((...message: unknown[]) => {
    const str = message.map(String).join(" ");
    if (str.includes("NotSupportedError") || str.includes("AbortError")) {
      return;
    }
    if (str.includes("not wrapped in act(")) {
      return;
    }
    if (str.includes("suspended inside an `act` scope")) {
      return;
    }
    if (str.includes("Detached promise rejected")) {
      return;
    }
    const err = message[0];
    throw err instanceof Error ? err : new Error(err as unknown as string);
  });
});

// Reset handlers after each test
afterEach(async () => {
  await clearAllDetached();
  server.resetHandlers();
});

// Close server after all tests
afterAll(() => {
  server.close();
});
