/**
 * Org API Handlers
 *
 * Mock handlers for /api/zero/org endpoint (org API via zero layer).
 * Default behavior: user always has an org (for tests that need auth to work).
 */

import { zeroOrgContract, type OrgResponse } from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

// Mock org data — default to admin role for development
const mockOrg: OrgResponse = {
  id: "org_1",
  slug: "user-12345678",
  name: "User 12345678",
  role: "admin",
};

export const apiOrgHandlers = [
  mockApi(zeroOrgContract.get, ({ respond }) => {
    return respond(200, mockOrg);
  }),
];
