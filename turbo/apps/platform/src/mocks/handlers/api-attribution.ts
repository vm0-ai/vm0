import { zeroAttributionContract } from "@vm0/api-contracts/contracts/zero-attribution";
import { mockApi } from "../msw-contract.ts";

export const apiAttributionHandlers = [
  mockApi(zeroAttributionContract.recordSignup, ({ respond }) => {
    return respond(200, { recorded: true });
  }),
];
