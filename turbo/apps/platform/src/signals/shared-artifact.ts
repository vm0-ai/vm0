import { command } from "ccstate";
import { createElement } from "react";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { z } from "zod";
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
    const requestedId = String(get(pathParams$)?.artifactShareId ?? "");
    const legacyId = z.uuid().safeParse(requestedId);
    const id = legacyId.success
      ? artifactReferencePath(legacyId.data).slice("/artifacts/".length)
      : requestedId;
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.loaded) {
      return;
    }
    if (!clerk.user) {
      const returnUrl = new URL(
        `/artifacts/${encodeURIComponent(id)}`,
        location.origin,
      );
      returnUrl.hash = location.hash;
      window.location.replace(
        clerk.buildSignInUrl({ redirectUrl: returnUrl.href }),
      );
      return;
    }
    const result = await accept(
      get(apiClient$)(artifactReferencesContract).resolve({
        params: { reference: id },
        fetchOptions: { signal, cache: "no-store" },
      }),
      [200, 400, 404],
      signal,
    );
    if (result.status === 200) {
      const contentUrl = new URL(result.body.url);
      contentUrl.hash = location.hash;
      window.location.replace(contentUrl.href);
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
