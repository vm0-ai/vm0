import {
  emailSubscriptionContract,
  type EmailSubscriptionResponse,
} from "@okouai/api-contracts/contracts/email-subscription";

import { mockApi } from "../msw-contract.ts";

let subscribed = true;

export function resetMockEmailSubscription(): void {
  subscribed = true;
}

export const apiEmailSubscriptionHandlers = [
  mockApi(emailSubscriptionContract.get, ({ respond }) => {
    return respond(200, {
      subscribed,
      email: "test@example.com",
      deliveryStatus: "available",
    } satisfies EmailSubscriptionResponse);
  }),
  mockApi(emailSubscriptionContract.update, ({ body, respond }) => {
    subscribed = body.subscribed;
    return respond(200, { subscribed });
  }),
];
