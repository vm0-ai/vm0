import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { mockApi } from "../msw-contract.ts";

export const apiAttributionHandlers = [
  mockApi(acquisitionAttributionContract.recordSignup, ({ respond }) => {
    return respond(200, { recorded: true });
  }),
];
