import { afterEach, beforeEach, vi } from "vitest";
import worker from "./index";

/** Cloudflare's named caches and content cache are separate external stores. */
export function memoryCache() {
  const entries = new Map<string, Response>();
  return {
    match: vi.fn(async (request: Request) => {
      return entries.get(request.url)?.clone();
    }),
    put: vi.fn(async (request: Request, response: Response) => {
      entries.set(request.url, response);
    }),
  };
}

beforeEach(() => {
  const registry = memoryCache();
  vi.stubGlobal("caches", {
    default: memoryCache(),
    open: async () => {
      return registry;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Own Cloudflare background cache work through the response's test lifetime. */
export async function fetchWorker(
  request: Request,
  env: Parameters<typeof worker.fetch>[1],
): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(request, env, {
    waitUntil(promise) {
      pending.push(promise);
    },
  });
  await Promise.all(pending);
  return response;
}
