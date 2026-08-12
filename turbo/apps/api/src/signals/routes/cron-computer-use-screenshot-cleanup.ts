import { cronComputerUseScreenshotCleanupContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import {
  cleanupComputerUseScreenshots$,
  type ComputerUseScreenshotCleanupOptions,
} from "../services/cron-computer-use-screenshot-cleanup.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

function computerUseScreenshotCleanupRoute(
  options: ComputerUseScreenshotCleanupOptions,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const cleaned = await set(cleanupComputerUseScreenshots$, options, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { cleaned },
    };
  });
}

function computerUseScreenshotCleanupRoutes(
  options: ComputerUseScreenshotCleanupOptions,
): readonly RouteEntry[] {
  return [
    {
      route: cronComputerUseScreenshotCleanupContract.cleanup,
      handler: computerUseScreenshotCleanupRoute(options),
    },
  ];
}

export function cronComputerUseScreenshotCleanupRoutesForTest(
  commandIds: readonly string[],
): readonly RouteEntry[] {
  return computerUseScreenshotCleanupRoutes({ commandIds });
}

export const cronComputerUseScreenshotCleanupRoutes =
  computerUseScreenshotCleanupRoutes({});
