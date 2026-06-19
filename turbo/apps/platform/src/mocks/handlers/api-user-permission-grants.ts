import {
  type ApplyCompactUserPermissionGrant,
  type CompactUserPermissionGrantResponse,
  type UserPermissionGrantResponse,
  zeroUserPermissionGrantsContract,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import { nowDate } from "../../lib/time.ts";
import { userPermissionGrantExpiresAt } from "../../signals/permission-allow/permission-grant-expiration.ts";
import { mockApi } from "../msw-contract.ts";

let mockUserPermissionGrants: CompactUserPermissionGrantResponse[] = [];

function grantKey(
  grant: Pick<
    CompactUserPermissionGrantResponse,
    "agentId" | "connectorRef"
  > & {
    readonly target: CompactUserPermissionGrantResponse["target"];
  },
): string {
  switch (grant.target.kind) {
    case "connector-default": {
      return `${grant.agentId}:${grant.connectorRef}:connector-default`;
    }
    case "permission": {
      return `${grant.agentId}:${grant.connectorRef}:permission:${grant.target.permission}`;
    }
    case "unknown-endpoint": {
      return `${grant.agentId}:${grant.connectorRef}:unknown-endpoint`;
    }
  }
}

function isActiveGrant(
  grant: CompactUserPermissionGrantResponse,
  checkedAt: Date,
) {
  return grant.expiresAt === null || new Date(grant.expiresAt) > checkedAt;
}

function resolvedMockExpiresAt(
  existing: CompactUserPermissionGrantResponse | undefined,
  action: CompactUserPermissionGrantResponse["action"],
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

export function resetMockUserPermissionGrants(): void {
  mockUserPermissionGrants = [];
}

function legacyGrantFromCompact(
  grant: CompactUserPermissionGrantResponse,
): UserPermissionGrantResponse | null {
  switch (grant.target.kind) {
    case "connector-default": {
      return null;
    }
    case "permission": {
      return {
        agentId: grant.agentId,
        connectorRef: grant.connectorRef,
        permission: grant.target.permission,
        action: grant.action,
        expiresAt: grant.expiresAt,
        createdAt: grant.createdAt,
        updatedAt: grant.updatedAt,
      };
    }
    case "unknown-endpoint": {
      return {
        agentId: grant.agentId,
        connectorRef: grant.connectorRef,
        permission: UNKNOWN_PERMISSION_GRANT,
        action: grant.action,
        expiresAt: grant.expiresAt,
        createdAt: grant.createdAt,
        updatedAt: grant.updatedAt,
      };
    }
  }
}

function legacyTarget(
  permission: string,
): ApplyCompactUserPermissionGrant["target"] {
  return permission === UNKNOWN_PERMISSION_GRANT
    ? { kind: "unknown-endpoint" }
    : { kind: "permission", permission };
}

export const apiUserPermissionGrantsHandlers = [
  mockApi(zeroUserPermissionGrantsContract.list, ({ query, respond }) => {
    const checkedAt = nowDate();
    return respond(
      200,
      mockUserPermissionGrants
        .filter((grant) => {
          return (
            grant.agentId === query.agentId && isActiveGrant(grant, checkedAt)
          );
        })
        .flatMap((grant) => {
          const legacyGrant = legacyGrantFromCompact(grant);
          return legacyGrant ? [legacyGrant] : [];
        }),
    );
  }),

  mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
    const now = nowDate();
    const target = legacyTarget(body.permission);
    const existing = mockUserPermissionGrants.find((grant) => {
      return grantKey(grant) === grantKey({ ...body, target });
    });
    const grant: CompactUserPermissionGrantResponse = {
      agentId: body.agentId,
      connectorRef: body.connectorRef,
      target,
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

    const legacyGrant = legacyGrantFromCompact(grant);
    if (!legacyGrant) {
      throw new Error("Legacy permission grant mock created no grant");
    }
    return respond(200, legacyGrant);
  }),

  mockApi(
    zeroUserPermissionGrantsContract.compactList,
    ({ query, respond }) => {
      const checkedAt = nowDate();
      return respond(
        200,
        mockUserPermissionGrants.filter((grant) => {
          return (
            grant.agentId === query.agentId && isActiveGrant(grant, checkedAt)
          );
        }),
      );
    },
  ),

  mockApi(
    zeroUserPermissionGrantsContract.compactApply,
    ({ body, respond }) => {
      const now = nowDate();
      const existing = new Map(
        mockUserPermissionGrants
          .filter((grant) => {
            return (
              grant.agentId === body.agentId &&
              grant.connectorRef === body.connectorRef
            );
          })
          .map((grant) => {
            return [grantKey(grant), grant] as const;
          }),
      );
      const grants = body.grants.map((grant) => {
        const key = grantKey({
          agentId: body.agentId,
          connectorRef: body.connectorRef,
          target: grant.target,
        });
        const current = existing.get(key);
        return {
          agentId: body.agentId,
          connectorRef: body.connectorRef,
          target: grant.target,
          action: grant.action,
          expiresAt: resolvedMockExpiresAt(
            current,
            grant.action,
            grant.expiresIn,
            now,
          ),
          createdAt: current?.createdAt ?? now.toISOString(),
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
    },
  ),

  mockApi(zeroUserPermissionGrantsContract.reset, ({ query, respond }) => {
    mockUserPermissionGrants = mockUserPermissionGrants.filter((grant) => {
      return (
        grant.agentId !== query.agentId ||
        grant.connectorRef !== query.connectorRef
      );
    });

    return respond(204);
  }),
];
