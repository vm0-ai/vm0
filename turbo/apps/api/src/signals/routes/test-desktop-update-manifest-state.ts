import { testDesktopUpdateManifestStateContract } from "@vm0/api-contracts/contracts/test-desktop-update-manifest-state";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import { clearDesktopUpdateManifestCacheForTest } from "../services/desktop-updates.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const resetDesktopUpdateManifestState$ = command(({ get }) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }

  clearDesktopUpdateManifestCacheForTest();
  return { status: 200 as const, body: { ok: true as const } };
});

export const testDesktopUpdateManifestStateRoutes: readonly RouteEntry[] = [
  {
    route: testDesktopUpdateManifestStateContract.reset,
    handler: resetDesktopUpdateManifestState$,
  },
];
