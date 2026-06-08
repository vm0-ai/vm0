import {
  type UserPermissionGrantResponse,
  zeroUserPermissionGrantsContract,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { userPermissionGrantExpiresAt } from "../../signals/permission-allow/permission-grant-expiration.ts";
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

function isActiveGrant(grant: UserPermissionGrantResponse, checkedAt: Date) {
  return grant.expiresAt === null || new Date(grant.expiresAt) > checkedAt;
}

function resolvedMockExpiresAt(
  existing: UserPermissionGrantResponse | undefined,
  action: UserPermissionGrantResponse["action"],
  expiresIn: Parameters<typeof userPermissionGrantExpiresAt>[0],
  now: Date,
): string | null {
  if (action !== "allow") {
    return null;
  }
  if (expiresIn !== undefined) {
    return userPermissionGrantExpiresAt(expiresIn, now.getTime());
  }
  if (existing?.action === "allow" && isActiveGrant(existing, now)) {
    return existing.expiresAt;
  }
  return null;
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
    const checkedAt = new Date();
    return respond(
      200,
      mockUserPermissionGrants.filter((grant) => {
        return (
          grant.agentId === query.agentId && isActiveGrant(grant, checkedAt)
        );
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
      expiresAt: resolvedMockExpiresAt(
        existing,
        body.action,
        body.expiresIn,
        now,
      ),
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
