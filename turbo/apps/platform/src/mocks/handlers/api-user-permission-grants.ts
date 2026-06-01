import {
  type UserPermissionGrantResponse,
  zeroUserPermissionGrantsContract,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { mockApi } from "../msw-contract.ts";

let mockUserPermissionGrants: UserPermissionGrantResponse[] = [];

function grantKey(
  grant: Pick<
    UserPermissionGrantResponse,
    "agentId" | "connectorRef" | "permission"
  >,
): string {
  return `${grant.agentId}:${grant.connectorRef}:${grant.permission}`;
}

export function createMockUserPermissionGrantResponse(
  overrides: Partial<UserPermissionGrantResponse>,
): UserPermissionGrantResponse {
  const now = new Date().toISOString();
  return {
    agentId: "c0000000-0000-4000-a000-000000000001",
    connectorRef: "slack",
    permission: "channels:read",
    action: "allow",
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function setMockUserPermissionGrants(
  grants: UserPermissionGrantResponse[],
): void {
  mockUserPermissionGrants = grants;
}

export function resetMockUserPermissionGrants(): void {
  mockUserPermissionGrants = [];
}

export const apiUserPermissionGrantsHandlers = [
  mockApi(zeroUserPermissionGrantsContract.list, ({ query, respond }) => {
    return respond(
      200,
      mockUserPermissionGrants.filter((grant) => {
        return grant.agentId === query.agentId;
      }),
    );
  }),

  mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
    const now = new Date();
    const existing = mockUserPermissionGrants.find((grant) => {
      return grantKey(grant) === grantKey(body);
    });
    const grant: UserPermissionGrantResponse = {
      agentId: body.agentId,
      connectorRef: body.connectorRef,
      permission: body.permission,
      action: body.action,
      expiresAt: null,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };

    mockUserPermissionGrants = [
      ...mockUserPermissionGrants.filter((current) => {
        return grantKey(current) !== grantKey(grant);
      }),
      grant,
    ];

    return respond(200, grant);
  }),
];
