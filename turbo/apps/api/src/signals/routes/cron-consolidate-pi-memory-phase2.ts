import {
  cronConsolidatePiMemoryPhase2Contract,
  type CronConsolidatePiMemoryPhase2Response,
} from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import {
  executePiMemoryPhase2Work$,
  type PiMemoryPhase2WorkerResult,
} from "../services/pi-memory-phase2-worker.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";
import { admitsPiMemoryBackgroundWorkerInvocation } from "./pi-memory-background-worker-breaker";

interface PiMemoryPhase2RouteScope {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
}

const ZERO_PHASE2_RESPONSE: CronConsolidatePiMemoryPhase2Response =
  Object.freeze({
    success: true,
    claimed: 0,
    noWork: 0,
    noDiff: 0,
    published: 0,
    conflicted: 0,
    stale: 0,
    failed: 0,
  });

function responseForPhase2Result(
  result: PiMemoryPhase2WorkerResult,
): CronConsolidatePiMemoryPhase2Response {
  const claimed = result.outcome === "no_work" ? 0 : 1;
  return {
    success: true,
    claimed,
    noWork: result.outcome === "no_work" ? 1 : 0,
    noDiff: result.outcome === "no_diff" ? 1 : 0,
    published: result.outcome === "published" ? 1 : 0,
    conflicted: result.outcome === "conflicted" ? 1 : 0,
    stale: result.outcome === "stale" ? 1 : 0,
    failed: result.outcome === "failed" ? 1 : 0,
  };
}

function consolidatePiMemoryPhase2Routes(
  scope: PiMemoryPhase2RouteScope | undefined,
): readonly RouteEntry[] {
  const consolidatePiMemoryPhase2Route$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      if (!get(hasValidCronSecret$)) {
        return cronUnauthorized();
      }
      if (!admitsPiMemoryBackgroundWorkerInvocation("phase2")) {
        return { status: 200 as const, body: ZERO_PHASE2_RESPONSE };
      }
      signal.throwIfAborted();
      const result = await set(
        executePiMemoryPhase2Work$,
        { scope, currentTime: nowDate() },
        signal,
      );
      signal.throwIfAborted();
      return { status: 200 as const, body: responseForPhase2Result(result) };
    },
  );

  return [
    {
      route: cronConsolidatePiMemoryPhase2Contract.consolidate,
      handler: consolidatePiMemoryPhase2Route$,
    },
  ];
}

export function cronConsolidatePiMemoryPhase2RoutesForTest(
  scope: PiMemoryPhase2RouteScope,
): readonly RouteEntry[] {
  return consolidatePiMemoryPhase2Routes(scope);
}

export const cronConsolidatePiMemoryPhase2Routes =
  consolidatePiMemoryPhase2Routes(undefined);
