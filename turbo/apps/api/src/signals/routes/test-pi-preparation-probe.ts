import { testPiPreparationProbeContract } from "@okouai/api-contracts/contracts/test-pi-preparation-probe";
import { command } from "ccstate";

import { optionalEnv } from "../../lib/env";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { runPiPreparationProbe } from "../services/pi-preparation-probe.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const probeBody$ = bodyResultOf(testPiPreparationProbeContract.run);

const runPiPreparationProbeRoute$ = command(
  async ({ get }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(probeBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const result = await runPiPreparationProbe(
      {
        iterations: bodyResult.data.iterations,
        mode: bodyResult.data.mode,
        profile: bodyResult.data.profile,
        rebuildFixture: bodyResult.data.rebuild_fixture,
        region: optionalEnv("VERCEL_REGION") ?? null,
      },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: result };
  },
);

export const testPiPreparationProbeRoutes: readonly RouteEntry[] = [
  {
    route: testPiPreparationProbeContract.run,
    handler: runPiPreparationProbeRoute$,
  },
];
