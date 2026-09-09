import { command } from "ccstate";
import { createElement } from "react";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { accept } from "../lib/accept.ts";
import { i18n } from "../i18n/index.ts";
import { clerk$ } from "./auth.ts";
import { apiClient$ } from "./api-client.ts";
import { pathParams$ } from "./route.ts";
import { updatePage$ } from "./react-router.ts";
import { hideAppSkeleton$ } from "./app-skeleton.ts";

// This is a login/authorization handoff, never an artifact viewer or iframe.
export const setupSharedArtifact$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const id = String(get(pathParams$)?.artifactShareId ?? "");
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.loaded) {
      return;
    }
    if (!clerk.user) {
      const returnUrl = new URL(
        `/share/artifacts/${encodeURIComponent(id)}`,
        location.origin,
      ).href;
      window.location.replace(clerk.buildSignInUrl({ redirectUrl: returnUrl }));
      return;
    }
    const result = await accept(
      get(apiClient$)(artifactSharesContract).resolve({
        params: { id },
        fetchOptions: { signal, cache: "no-store" },
      }),
      [200, 404],
      signal,
    );
    if (result.status === 200) {
      window.location.replace(result.body.url);
      return;
    }
    set(
      updatePage$,
      createElement(
        "p",
        { className: "p-8 text-muted-foreground" },
        i18n.t(($) => {
          return $.artifacts.sharing.unavailable;
        }),
      ),
    );
    await set(hideAppSkeleton$, signal);
  },
);
