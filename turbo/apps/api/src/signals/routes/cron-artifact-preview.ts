import { cronArtifactPreviewContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { generateArtifactPreviews$ } from "../services/artifact-preview.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const artifactPreviewRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const generated = await set(generateArtifactPreviews$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { generated },
    };
  },
);

export const cronArtifactPreviewRoutes: readonly RouteEntry[] = [
  {
    route: cronArtifactPreviewContract.generate,
    handler: artifactPreviewRoute$,
  },
];
