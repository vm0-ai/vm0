/**
 * Feature Switches API Handlers
 *
 * Mock handlers for /api/okou/feature-switches endpoint.
 *
 * Stateless: defaults return empty switches. Tests override the GET response
 * via `setMockFeatureSwitches` from `./api-feature-switches.helpers.ts` —
 * that file imports `server` (msw/node) and is intentionally separate so
 * default handlers stay free of test override side effects.
 */

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { mockApi } from "../msw-contract.ts";

const DEFAULT_SWITCH_OVERRIDES = {
  // Shared fixtures keep the projected-event reader available as the rollback
  // baseline. Snapshot-specific tests opt into the globally enabled path.
  [FeatureSwitchKey.ChatEventSnapshotRead]: false,
};

export const apiFeatureSwitchesHandlers = [
  mockApi(zeroFeatureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: DEFAULT_SWITCH_OVERRIDES,
      effectiveSwitches: DEFAULT_SWITCH_OVERRIDES,
      apiCapabilities: { feedbackLocationV1: true },
    });
  }),

  mockApi(zeroFeatureSwitchesContract.update, ({ body, respond }) => {
    return respond(200, {
      switches: body.switches,
      effectiveSwitches: body.switches,
      apiCapabilities: { feedbackLocationV1: true },
    });
  }),

  mockApi(zeroFeatureSwitchesContract.delete, ({ respond }) => {
    return respond(200, { deleted: true as const });
  }),
];
