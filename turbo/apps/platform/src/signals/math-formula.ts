import { computed } from "ccstate";

import { rootSignal$ } from "./root-signal.ts";
import { createDeferredPromise, withCleanup } from "./utils.ts";

const KATEX_VERSION = "0.18.7";
const KATEX_RUNTIME_PATH = `vendor/katex-${KATEX_VERSION}/katex.min.js`;

function bundledAssetUrl(path: string): string {
  return new URL(path, import.meta.url).href;
}

const KATEX_RUNTIME_URL = import.meta.env.DEV
  ? `/${KATEX_RUNTIME_PATH}`
  : bundledAssetUrl(`../${KATEX_RUNTIME_PATH}`);

interface KatexRenderOptions {
  readonly displayMode: boolean;
  readonly errorColor: string;
  readonly maxExpand: number;
  readonly maxSize: number;
  readonly output: "mathml";
  readonly throwOnError: false;
  readonly trust: false;
}

export interface KatexBrowserRuntime {
  readonly renderToString: (
    source: string,
    options: KatexRenderOptions,
  ) => string;
}

declare global {
  interface Window {
    readonly katex?: KatexBrowserRuntime;
  }
}

function currentKatexRuntime(): KatexBrowserRuntime | undefined {
  return window.katex;
}

function loadKatexRuntime(signal: AbortSignal): Promise<KatexBrowserRuntime> {
  signal.throwIfAborted();
  const loaded = currentKatexRuntime();
  if (loaded) {
    return Promise.resolve(loaded);
  }

  const script = document.createElement("script");
  script.async = true;
  script.dataset.okouKatexRuntime = KATEX_VERSION;
  script.src = KATEX_RUNTIME_URL;

  const deferred = createDeferredPromise<KatexBrowserRuntime>(signal);
  const handleLoad = (): void => {
    const runtime = currentKatexRuntime();
    if (!runtime) {
      deferred.reject(new Error("KaTeX did not expose its browser runtime"));
      return;
    }
    deferred.resolve(runtime);
  };
  const handleError = (): void => {
    deferred.reject(new Error("KaTeX browser runtime failed to load"));
  };
  const cleanup = (): void => {
    script.removeEventListener("load", handleLoad);
    script.removeEventListener("error", handleError);
    if (!currentKatexRuntime()) {
      script.remove();
    }
  };

  script.addEventListener("load", handleLoad, { once: true });
  script.addEventListener("error", handleError, { once: true });
  document.head.appendChild(script);
  return withCleanup(deferred.promise, cleanup);
}

export const katexBrowserRuntime$ = computed((get) => {
  return loadKatexRuntime(get(rootSignal$));
});
