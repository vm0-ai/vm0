/**
 * Feature Switches API Handlers
 *
 * Mock handlers for /api/zero/feature-switches endpoint.
 *
 * Stateless: defaults return empty switches. Tests override the GET response
 * via `setMockFeatureSwitches` from `./api-feature-switches.helpers.ts` —
 * that file imports `server` (msw/node) and is intentionally separate so
 * default handlers stay free of test override side effects.
 */

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { mockApi } from "../msw-contract.ts";

// workflowAutomation went globally on with the automation -> workflow cutover
// (#19959), which swaps the plain-textarea composer for the tiptap workflow
// composer. The platform suite predates that flip and drives the textarea, so
// the DEFAULT handler pins the switch off as a server-side override. Tests
// that register their own GET handler or pass `featureSwitches` to setupPage
// take precedence as usual. Migrating the suite to the tiptap default is
// tracked with the legacy automation removal.
const DEFAULT_SWITCH_OVERRIDES = {
  [FeatureSwitchKey.WorkflowAutomation]: false,
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
