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
    "agentId" | "workflowId" | "connectorRef" | "permission"
  >,
): string {
  const scope = grant.workflowId
    ? `workflow:${grant.workflowId}`
    : `agent:${grant.agentId}`;
  return `${scope}:${grant.connectorRef}:${grant.permission}`;
}

function sameScope(
  grant: UserPermissionGrantResponse,
  scope: { readonly agentId?: string; readonly workflowId?: string },
): boolean {
  return scope.workflowId
    ? grant.workflowId === scope.workflowId
    : grant.agentId === scope.agentId;
}

function isActiveGrant(grant: UserPermissionGrantResponse, checkedAt: Date) {
  return grant.expiresAt === null || new Date(grant.expiresAt) > checkedAt;
}

function resolvedMockExpiresAt({
  existing,
  action,
  expiresIn,
  preserveExisting,
  now,
}: {
  readonly existing: UserPermissionGrantResponse | undefined;
  readonly action: UserPermissionGrantResponse["action"];
  readonly expiresIn: Parameters<typeof userPermissionGrantExpiresAt>[0];
  readonly preserveExisting: boolean;
  readonly now: Date;
}): string | null {
  if (action !== "allow") {
    return null;
  }
  if (expiresIn !== undefined) {
    return userPermissionGrantExpiresAt(expiresIn, now.getTime());
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

export function resetMockUserPermissionGrants(): void {
  mockUserPermissionGrants = [];
}

export const apiUserPermissionGrantsHandlers = [
  mockApi(zeroUserPermissionGrantsContract.list, ({ query, respond }) => {
    const checkedAt = nowDate();
    return respond(
      200,
      mockUserPermissionGrants.filter((grant) => {
        return sameScope(grant, query) && isActiveGrant(grant, checkedAt);
      }),
    );
  }),

  mockApi(zeroUserPermissionGrantsContract.apply, ({ body, respond }) => {
    const now = nowDate();
    const seenPermissions = new Set<string>();
    for (const grant of body.grants) {
      if (seenPermissions.has(grant.permission)) {
        return respond(400, {
          error: {
            message: `Duplicate permission grant: ${grant.permission}`,
            code: "VALIDATION_ERROR",
          },
        });
      }
      seenPermissions.add(grant.permission);
    }

    const existingGrants =
      body.mode === "replace"
        ? []
        : mockUserPermissionGrants.filter((grant) => {
            return (
              sameScope(grant, body) && grant.connectorRef === body.connectorRef
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
        preserveExisting: true,
        now,
      });
      return {
        ...(body.workflowId
          ? { workflowId: body.workflowId }
          : { agentId: body.agentId }),
        connectorRef: body.connectorRef,
        permission: appliedGrant.permission,
        action: appliedGrant.action,
        expiresAt,
        createdAt: existing?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      };
    });
    const appliedKeys = new Set(
      grants.map((grant) => {
        return grantKey(grant);
      }),
    );

    mockUserPermissionGrants = [
      ...mockUserPermissionGrants.filter((grant) => {
        if (
          body.mode === "replace" &&
          sameScope(grant, body) &&
          grant.connectorRef === body.connectorRef
        ) {
          return false;
        }
        return !appliedKeys.has(grantKey(grant));
      }),
      ...grants,
    ];

    return respond(200, grants);
  }),
];
