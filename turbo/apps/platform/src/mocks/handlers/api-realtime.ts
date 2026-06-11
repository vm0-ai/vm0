import { platformRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";

import { now } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";

export const apiRealtimeHandlers = [
  mockApi(platformRealtimeTokenContract.create, ({ respond }) => {
    return respond(200, {
      keyName: "mock-key",
      clientId: "test-user-123",
      timestamp: now(),
      capability: '{"*":["*"]}',
      nonce: "mock-nonce",
      mac: "mock-mac",
    });
  }),
];
