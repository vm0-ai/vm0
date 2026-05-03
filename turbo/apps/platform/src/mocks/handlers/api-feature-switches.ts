/**
 * Feature Switches API Handlers
 *
 * Mock handlers for /api/zero/feature-switches endpoint.
 *
 * Stateless: defaults return empty switches. Use `setMockFeatureSwitches` from
 * a test to override the GET response — it installs a fresh handler via
 * `server.use`, which is automatically reset between tests by the MSW
 * `server.resetHandlers()` afterEach hook.
 */

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";

import { mockApi } from "../msw-contract.ts";
import { server } from "../server.ts";

export const apiFeatureSwitchesHandlers = [
  mockApi(zeroFeatureSwitchesContract.get, ({ respond }) => {
    return respond(200, { switches: {} });
  }),

  mockApi(zeroFeatureSwitchesContract.update, ({ body, respond }) => {
    return respond(200, { switches: body.switches });
  }),

  mockApi(zeroFeatureSwitchesContract.delete, ({ respond }) => {
    return respond(200, { deleted: true as const });
  }),
];

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
