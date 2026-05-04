import { computed } from "ccstate";
import type { AppRouter } from "@ts-rest/core";
import { resolveApiBase } from "./api-base.ts";
import { createAuthedTsRestClient } from "./api-client-base.ts";

function rebaseApiPath(path: string, apiBase: string): string {
  const url = new URL(path, resolveApiBase(false));
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
  return `${base}${url.pathname}${url.search}${url.hash}`;
}

export const zeroClient$ = computed((_get) => {
  return <T extends AppRouter>(contract: T) => {
    return createAuthedTsRestClient(contract, {
      baseUrl: resolveApiBase(false),
      getToken: () => {
        return Promise.resolve(null);
      },
      resolvePath: (path) => {
        const apiBase = resolveApiBase(false);
        return rebaseApiPath(path, apiBase);
      },
    });
  };
});
