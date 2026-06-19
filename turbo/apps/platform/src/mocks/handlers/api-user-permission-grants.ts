import {
  type UserPermissionGrantResponse,
  zeroUserPermissionGrantsContract,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { nowDate } from "../../lib/time.ts";
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

function resolvedMockExpiresAt({
  existing,
  action,
  expiresIn,
  expiresAt,
  preserveExisting,
  now,
}: {
  readonly existing: UserPermissionGrantResponse | undefined;
  readonly action: UserPermissionGrantResponse["action"];
  readonly expiresIn: Parameters<typeof userPermissionGrantExpiresAt>[0];
  readonly expiresAt: string | undefined;
  readonly preserveExisting: boolean;
  readonly now: Date;
}): string | null {
  if (action !== "allow") {
    return null;
  }
  if (expiresIn !== undefined) {
    return userPermissionGrantExpiresAt(expiresIn, now.getTime());
  }
  if (expiresAt !== undefined) {
    return expiresAt;
  }
  if (
    preserveExisting &&
    existing?.action === "allow" &&
    isActiveGrant(existing, now)
  ) {
    return existing.expiresAt;
  }
  return null;
}

function shouldPersistMockAppliedGrant(
  action: UserPermissionGrantResponse["action"],
  requestedExpiresAt: string | undefined,
  resolvedExpiresAt: string | null,
  now: Date,
): boolean {
  return (
    action !== "allow" ||
    requestedExpiresAt === undefined ||
    (resolvedExpiresAt !== null && new Date(resolvedExpiresAt) > now)
  );
}

export function resetMockUserPermissionGrants(): void {
  mockUserPermissionGrants = [];
}

export const apiUserPermissionGrantsHandlers = [
  mockApi(zeroUserPermissionGrantsContract.list, ({ query, respond }) => {
    const checkedAt = nowDate();
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
    const now = nowDate();
    const existing = mockUserPermissionGrants.find((grant) => {
      return grantKey(grant) === grantKey(body);
    });
    const grant: UserPermissionGrantResponse = {
      agentId: body.agentId,
      connectorRef: body.connectorRef,
      permission: body.permission,
      action: body.action,
      expiresAt: resolvedMockExpiresAt({
        existing,
        action: body.action,
        expiresIn: body.expiresIn,
        expiresAt: undefined,
        preserveExisting: true,
        now,
      }),
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

  mockApi(zeroUserPermissionGrantsContract.apply, ({ body, respond }) => {
    const now = nowDate();
    const existingGrants = mockUserPermissionGrants.filter((grant) => {
      return (
        grant.agentId === body.agentId &&
        grant.connectorRef === body.connectorRef
      );
    });
    const existingGrantsByPermission = new Map(
      existingGrants.map((grant) => {
        return [grant.permission, grant] as const;
      }),
    );
    const grants = body.grants.flatMap((appliedGrant) => {
      const existing = existingGrantsByPermission.get(appliedGrant.permission);
      const expiresAt = resolvedMockExpiresAt({
        existing,
        action: appliedGrant.action,
        expiresIn: appliedGrant.expiresIn,
        expiresAt: appliedGrant.expiresAt,
        preserveExisting: false,
        now,
      });
      if (
        !shouldPersistMockAppliedGrant(
          appliedGrant.action,
          appliedGrant.expiresAt,
          expiresAt,
          now,
        )
      ) {
        return [];
      }
      return {
        agentId: body.agentId,
        connectorRef: body.connectorRef,
        permission: appliedGrant.permission,
        action: appliedGrant.action,
        expiresAt,
        createdAt: existing?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      };
    });

    mockUserPermissionGrants = [
      ...mockUserPermissionGrants.filter((grant) => {
        return (
          grant.agentId !== body.agentId ||
          grant.connectorRef !== body.connectorRef
        );
      }),
      ...grants,
    ];

    return respond(200, grants);
  }),
];
