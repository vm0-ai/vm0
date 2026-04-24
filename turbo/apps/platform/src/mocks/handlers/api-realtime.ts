import { platformRealtimeTokenContract } from "@vm0/core/contracts/realtime";
import { mockApi } from "../msw-contract.ts";

export const apiRealtimeHandlers = [
  mockApi(platformRealtimeTokenContract.create, ({ respond }) => {
    return respond(200, {
      keyName: "mock-key",
      clientId: "test-user-123",
      timestamp: Date.now(),
      capability: '{"*":["*"]}',
      nonce: "mock-nonce",
      mac: "mock-mac",
    });
  }),
];
