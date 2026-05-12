/**
 * Feature Switches API Handlers
 *
 * Mock handlers for /api/zero/feature-switches endpoint.
 *
 * Stateless: defaults return empty switches. Tests override the GET response
 * via `setMockFeatureSwitches` from `./api-feature-switches.helpers.ts` —
 * that file imports `server` (msw/node) and is intentionally separate so
 * browser tests, which transitively import `handlers/index.ts` to wire up
 * `mocks/browser.ts`, do not pull in `node:http` through this module.
 */

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { mockApi } from "../msw-contract.ts";

const DEFAULT_MOCK_FEATURE_SWITCHES: Record<string, boolean> = {
  [FeatureSwitchKey.ModelFirstModelProvider]: true,
};

export const apiFeatureSwitchesHandlers = [
  mockApi(zeroFeatureSwitchesContract.get, ({ respond }) => {
    return respond(200, { switches: DEFAULT_MOCK_FEATURE_SWITCHES });
  }),

  mockApi(zeroFeatureSwitchesContract.update, ({ body, respond }) => {
    return respond(200, {
      switches: { ...DEFAULT_MOCK_FEATURE_SWITCHES, ...body.switches },
    });
  }),

  mockApi(zeroFeatureSwitchesContract.delete, ({ respond }) => {
    return respond(200, { deleted: true as const });
  }),
];
