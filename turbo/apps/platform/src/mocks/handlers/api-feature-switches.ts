/**
 * Feature Switches API Handlers
 *
 * Mock handlers for /api/feature-switches endpoint.
 *
 * Stateless: defaults return empty switches. Tests override the GET response
 * via `setMockFeatureSwitches` from `./api-feature-switches.helpers.ts` —
 * that file imports `server` (msw/node) and is intentionally separate so
 * default handlers stay free of test override side effects.
 */

import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { mockApi } from "../msw-contract.ts";

const DEFAULT_SWITCH_OVERRIDES = {};

export const apiFeatureSwitchesHandlers = [
  mockApi(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: DEFAULT_SWITCH_OVERRIDES,
      effectiveSwitches: DEFAULT_SWITCH_OVERRIDES,
    });
  }),

  mockApi(featureSwitchesContract.update, ({ body, respond }) => {
    return respond(200, {
      switches: body.switches,
      effectiveSwitches: body.switches,
    });
  }),

  mockApi(featureSwitchesContract.delete, ({ respond }) => {
    return respond(200, { deleted: true as const });
  }),
];
