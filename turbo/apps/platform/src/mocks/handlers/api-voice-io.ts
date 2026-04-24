/**
 * Voice IO API Handlers
 *
 * Mock handlers for /api/zero/voice-io endpoints.
 * Default behavior: quota endpoint returns `allowed: true` with unlimited
 * (limit: null) so tests that don't care about quota don't produce
 * unhandled-request warnings. Tests that need specific quota state should
 * override via `server.use(mockApi(zeroVoiceIoQuotaContract.get, ...))`.
 */

import { zeroVoiceIoQuotaContract } from "@vm0/core/contracts/zero-voice-io-quota";
import { mockApi } from "../msw-contract.ts";

export const apiVoiceIoHandlers = [
  mockApi(zeroVoiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit: null });
  }),
];
