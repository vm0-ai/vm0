/**
 * Test-side override helper for the /api/zero/feature-switches GET handler.
 *
 * Kept separate from `api-feature-switches.ts` so it does not get pulled into
 * `mocks/browser.ts` (which aggregates default handlers via
 * `handlers/index.ts`). Importing `server` from `mocks/server.ts` transitively
 * loads `msw/node`, which references `node:http` and breaks Vitest browser
 * tests run under Vite's browser environment.
 */

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";

import { mockApi } from "../msw-contract.ts";
import { server } from "../server.ts";

export function setMockFeatureSwitches(
  switches: Partial<Record<string, boolean>>,
): void {
  const sanitized: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(switches)) {
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }
  server.use(
    mockApi(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, { switches: sanitized });
    }),
  );
}
