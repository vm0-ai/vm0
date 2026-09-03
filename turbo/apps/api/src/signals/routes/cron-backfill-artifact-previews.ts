import { cronBackfillArtifactPreviewsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { backfillArtifactPreviews$ } from "../services/artifact-preview.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const backfillArtifactPreviewsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const result = await set(backfillArtifactPreviews$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronBackfillArtifactPreviewsRoutes: readonly RouteEntry[] = [
  {
    route: cronBackfillArtifactPreviewsContract.backfill,
    handler: backfillArtifactPreviewsRoute$,
  },
];
