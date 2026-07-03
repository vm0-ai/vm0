import { buildInfoContract } from "@vm0/api-contracts/contracts/build-info";

import { mockApi } from "../msw-contract.ts";

export const MOCK_BACKEND_COMMIT_SHA =
  "fedcba9876543210fedcba9876543210fedcba98";

export const apiBuildInfoHandlers = [
  mockApi(buildInfoContract.get, ({ respond }) => {
    return respond(200, { commitSha: MOCK_BACKEND_COMMIT_SHA });
  }),
];
