/**
 * Permission Policies API Handlers
 *
 * Mock handlers for /api/zero/permission-policies endpoints.
 */

import { zeroAgentPermissionPoliciesContract } from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

export const apiPermissionPoliciesHandlers = [
  mockApi(zeroAgentPermissionPoliciesContract.update, ({ body, respond }) => {
    return respond(200, {
      agentId: body.agentId,
      ownerId: "test-user-123",
      description: null,
      displayName: null,
      sound: null,
      avatarUrl: null,
      permissionPolicies: body.policies,
      customSkills: [],
    });
  }),
];
