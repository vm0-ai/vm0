/**
 * Feature Switches API Handlers
 *
 * Mock handlers for /api/zero/feature-switches endpoint.
 *
 * Stateless: defaults pin only the switches whose production default would
 * change which pipeline generic fixtures exercise. Tests override the GET
 * response via `setMockFeatureSwitches` from
 * `./api-feature-switches.helpers.ts` — that file imports `server` (msw/node)
 * and is intentionally separate so default handlers stay free of test override
 * side effects.
 */

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { mockApi } from "../msw-contract.ts";

// Generic fixtures use projected ChatEvents. Snapshot behavior has a dedicated
// suite with v3 archive and raw-row endpoint fixtures.
const DEFAULT_SWITCH_OVERRIDES = {
  [FeatureSwitchKey.ChatEventSnapshotRead]: false,
};

export const apiFeatureSwitchesHandlers = [
  mockApi(zeroFeatureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: DEFAULT_SWITCH_OVERRIDES,
      effectiveSwitches: DEFAULT_SWITCH_OVERRIDES,
    });
  }),

  mockApi(zeroFeatureSwitchesContract.update, ({ body, respond }) => {
    return respond(200, {
      switches: body.switches,
      effectiveSwitches: body.switches,
    });
  }),

  mockApi(zeroFeatureSwitchesContract.delete, ({ respond }) => {
    return respond(200, { deleted: true as const });
  }),
];
