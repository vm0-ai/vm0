import { computed, type Computed } from "ccstate";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { pageSignal$ } from "../page-signal.ts";

export function createPresentationDraftByUrlFactory<T>(
  load: (
    url: string,
    signal: AbortSignal,
    createClient: ZeroClientFactory,
  ) => Promise<T>,
): {
  readonly get: (url: string) => Computed<Promise<T>>;
  readonly invalidate: (url: string) => void;
} {
  const cache = new Map<string, Computed<Promise<T>>>();
  const get = (url: string) => {
    const existing = cache.get(url);
    if (existing) {
      return existing;
    }
    const draft$ = computed((get) => {
      return load(url, get(pageSignal$), get(zeroClient$));
    });
    cache.set(url, draft$);
    return draft$;
  };
  return {
    get,
    invalidate: (url: string) => {
      cache.delete(url);
    },
  };
}
