import type { UserPermissionGrantResponse } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import type { FirewallPermissionDetailMetadata } from "@vm0/connectors/firewall-metadata";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
} from "@vm0/connectors/firewall-types";
import { describe, expect, it } from "vitest";

import {
  createEmptyPermissionDraftIntent,
  createPermissionDraftContext,
  hasPermissionDraftResetPersistedEffect,
  materializePermissionDraftForLegacySave,
  resolvePermissionDraftExpiration,
  resolvePermissionDraftGroupExpiration,
  resolvePermissionDraftUnknownPolicy,
  restorePermissionDraftPermission,
  restorePermissionDraftUnknown,
  setPermissionDraftExpiration,
  setPermissionDraftGroupAllowExpiration,
  setPermissionDraftGroupAllowPolicy,
  setPermissionDraftGroupExpiration,
  setPermissionDraftGroupPolicy,
  setPermissionDraftPolicy,
  stagePermissionDraftConnectorRestore,
} from "./permission-draft-intent.ts";

const READ_PERMISSIONS = [
  { name: "bookmarks:read" },
  { name: "channels:read" },
  { name: "channels:history" },
] as const;

const METADATA = {
  type: "slack",
  label: "Slack",
  permissionCount: READ_PERMISSIONS.length,
  permissions: READ_PERMISSIONS,
  categories: {
    categories: {
      "bookmarks:read": "Read",
      "channels:read": "Read",
      "channels:history": "Read",
    },
    displayOrder: ["Read"],
  },
  defaultPolicy: {
    permissionDefault: "allow",
    unknownPolicy: "allow",
  },
} satisfies FirewallPermissionDetailMetadata;

const INITIAL_POLICIES = {} satisfies FirewallPolicies;

function createGrant(
  permission: string,
  action: UserPermissionGrantResponse["action"],
  expiresAt: string | null = null,
): UserPermissionGrantResponse {
  return {
    agentId: "agent",
    connectorRef: "slack",
    permission,
    action,
    expiresAt,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  };
}

function createContext() {
  return createPermissionDraftContext({
    metadata: METADATA,
    initialPolicies: INITIAL_POLICIES,
  });
}

describe("permission draft intent", () => {
  it("does not materialize inherited expiration for denied permissions", () => {
    const context = createContext();
    let draft = createEmptyPermissionDraftIntent();

    draft = setPermissionDraftGroupPolicy({
      draft,
      category: "Read",
      permissions: READ_PERMISSIONS,
      policy: "allow",
    });
    draft = setPermissionDraftGroupExpiration({
      draft,
      category: "Read",
      permissions: READ_PERMISSIONS,
      expiresIn: "7d",
    });
    draft = setPermissionDraftPolicy({
      draft,
      permissionName: "bookmarks:read",
      policy: "deny",
    });

    const materialized = materializePermissionDraftForLegacySave({
      context,
      draft,
      permissions: READ_PERMISSIONS,
    });

    expect(materialized.policies.slack?.policies["bookmarks:read"]).toBe(
      "deny",
    );
    expect(materialized.expiresInByPermission).toMatchObject({
      "channels:read": "7d",
      "channels:history": "7d",
    });
    expect(materialized.expiresInByPermission).not.toHaveProperty(
      "bookmarks:read",
    );
  });

  it("keeps a permission re-allow explicit instead of inheriting group duration", () => {
    const context = createContext();
    let draft = createEmptyPermissionDraftIntent();

    draft = setPermissionDraftGroupExpiration({
      draft,
      category: "Read",
      permissions: READ_PERMISSIONS,
      expiresIn: "7d",
    });
    draft = setPermissionDraftPolicy({
      draft,
      permissionName: "bookmarks:read",
      policy: "deny",
    });
    draft = setPermissionDraftExpiration({
      draft,
      permissionName: "bookmarks:read",
      expiresIn: null,
    });
    draft = setPermissionDraftPolicy({
      draft,
      permissionName: "bookmarks:read",
      policy: "allow",
    });
    draft = setPermissionDraftExpiration({
      draft,
      permissionName: "bookmarks:read",
      expiresIn: "always",
    });

    expect(
      resolvePermissionDraftExpiration({
        context,
        draft,
        permissionName: "bookmarks:read",
      }),
    ).toBe("always");
    expect(
      resolvePermissionDraftGroupExpiration({
        context,
        draft,
        category: "Read",
        permissions: READ_PERMISSIONS,
      }),
    ).toBeUndefined();

    const materialized = materializePermissionDraftForLegacySave({
      context,
      draft,
      permissions: READ_PERMISSIONS,
    });

    expect(materialized.expiresInByPermission).toMatchObject({
      "bookmarks:read": "always",
      "channels:read": "7d",
    });
  });

  it("lets a row allow always override an inherited group duration", () => {
    const context = createContext();
    let draft = createEmptyPermissionDraftIntent();

    draft = setPermissionDraftGroupExpiration({
      draft,
      category: "Read",
      permissions: READ_PERMISSIONS,
      expiresIn: "7d",
    });
    draft = setPermissionDraftExpiration({
      draft,
      permissionName: "bookmarks:read",
      expiresIn: "always",
    });

    expect(
      resolvePermissionDraftExpiration({
        context,
        draft,
        permissionName: "bookmarks:read",
      }),
    ).toBe("always");
    expect(
      resolvePermissionDraftExpiration({
        context,
        draft,
        permissionName: "channels:read",
      }),
    ).toBe("7d");

    const materialized = materializePermissionDraftForLegacySave({
      context,
      draft,
      permissions: READ_PERMISSIONS,
    });

    expect(materialized.expiresInByPermission).toMatchObject({
      "bookmarks:read": "always",
      "channels:read": "7d",
    });
  });

  it("lets a denied row break inherited group duration", () => {
    const context = createContext();
    let draft = createEmptyPermissionDraftIntent();

    draft = setPermissionDraftGroupExpiration({
      draft,
      category: "Read",
      permissions: READ_PERMISSIONS,
      expiresIn: "7d",
    });
    draft = setPermissionDraftPolicy({
      draft,
      permissionName: "bookmarks:read",
      policy: "deny",
    });
    draft = setPermissionDraftExpiration({
      draft,
      permissionName: "bookmarks:read",
      expiresIn: "always",
    });

    expect(
      resolvePermissionDraftGroupExpiration({
        context,
        draft,
        category: "Read",
        permissions: READ_PERMISSIONS,
      }),
    ).toBeUndefined();

    const materialized = materializePermissionDraftForLegacySave({
      context,
      draft,
      permissions: READ_PERMISSIONS,
    });

    expect(materialized.policies.slack?.policies["bookmarks:read"]).toBe(
      "deny",
    );
    expect(materialized.expiresInByPermission).toMatchObject({
      "channels:read": "7d",
      "channels:history": "7d",
    });
    expect(materialized.expiresInByPermission).not.toHaveProperty(
      "bookmarks:read",
    );
  });

  it("clears row expiration overrides when setting a group duration", () => {
    const context = createContext();
    let draft = createEmptyPermissionDraftIntent();

    draft = setPermissionDraftExpiration({
      draft,
      permissionName: "bookmarks:read",
      expiresIn: "1h",
    });
    draft = setPermissionDraftGroupExpiration({
      draft,
      category: "Read",
      permissions: READ_PERMISSIONS,
      expiresIn: "7d",
    });

    expect(
      resolvePermissionDraftExpiration({
        context,
        draft,
        permissionName: "bookmarks:read",
      }),
    ).toBe("7d");
    expect(
      resolvePermissionDraftGroupExpiration({
        context,
        draft,
        category: "Read",
        permissions: READ_PERMISSIONS,
      }),
    ).toBe("7d");
  });

  it("only forces always for group members that were not already allowed", () => {
    const context = createContext();
    let draft = createEmptyPermissionDraftIntent();

    draft = setPermissionDraftGroupExpiration({
      draft,
      category: "Read",
      permissions: READ_PERMISSIONS,
      expiresIn: "7d",
    });
    draft = setPermissionDraftPolicy({
      draft,
      permissionName: "bookmarks:read",
      policy: "deny",
    });
    draft = setPermissionDraftGroupAllowPolicy({
      context,
      draft,
      category: "Read",
      permissions: READ_PERMISSIONS,
    });

    const materialized = materializePermissionDraftForLegacySave({
      context,
      draft,
      permissions: READ_PERMISSIONS,
    });

    expect(materialized.expiresInByPermission).toMatchObject({
      "bookmarks:read": "always",
      "channels:read": "7d",
      "channels:history": "7d",
    });
  });

  it("only clears expiring group grants when selecting allow always", () => {
    const context = createContext();
    const explicitGrants = new Map([
      [
        "bookmarks:read",
        createGrant("bookmarks:read", "allow", "2026-03-01T01:00:00.000Z"),
      ],
      ["channels:read", createGrant("channels:read", "allow")],
    ]);
    let draft = setPermissionDraftGroupPolicy({
      draft: createEmptyPermissionDraftIntent(),
      category: "Read",
      permissions: READ_PERMISSIONS,
      policy: "allow",
    });

    draft = setPermissionDraftGroupAllowExpiration({
      draft,
      category: "Read",
      permissions: READ_PERMISSIONS,
      explicitGrants,
      expiresIn: "always",
    });

    expect(
      resolvePermissionDraftExpiration({
        context,
        draft,
        permissionName: "bookmarks:read",
      }),
    ).toBe("always");
    expect(
      resolvePermissionDraftExpiration({
        context,
        draft,
        permissionName: "channels:read",
      }),
    ).toBeUndefined();
    expect(
      resolvePermissionDraftGroupExpiration({
        context,
        draft,
        category: "Read",
        permissions: READ_PERMISSIONS,
      }),
    ).toBeUndefined();
    expect(
      materializePermissionDraftForLegacySave({
        context,
        draft,
        permissions: READ_PERMISSIONS,
      }).expiresInByPermission,
    ).toStrictEqual({
      "bookmarks:read": "always",
    });
  });

  it("does not keep apply enabled when a connector restore is undone back to initial grants", () => {
    const explicitGrants = new Map([
      ["bookmarks:read", createGrant("bookmarks:read", "deny")],
    ]);
    const context = createPermissionDraftContext({
      metadata: METADATA,
      initialPolicies: {
        slack: {
          policies: {
            "bookmarks:read": "deny",
          },
        },
      },
    });
    let draft = stagePermissionDraftConnectorRestore({
      draft: createEmptyPermissionDraftIntent(),
    });

    expect(
      hasPermissionDraftResetPersistedEffect({
        context,
        draft,
        permissions: READ_PERMISSIONS,
        explicitGrants,
      }),
    ).toBe(true);

    draft = restorePermissionDraftPermission({
      draft,
      permissionName: "bookmarks:read",
    });

    expect(
      hasPermissionDraftResetPersistedEffect({
        context,
        draft,
        permissions: READ_PERMISSIONS,
        explicitGrants,
      }),
    ).toBe(false);
  });

  it("restores unknown policy to the initial value after a connector restore", () => {
    const explicitGrants = new Map([
      [UNKNOWN_PERMISSION_GRANT, createGrant(UNKNOWN_PERMISSION_GRANT, "deny")],
    ]);
    const context = createPermissionDraftContext({
      metadata: METADATA,
      initialPolicies: {
        slack: {
          policies: {},
          unknownPolicy: "deny",
        },
      },
    });
    let draft = stagePermissionDraftConnectorRestore({
      draft: createEmptyPermissionDraftIntent(),
    });

    expect(resolvePermissionDraftUnknownPolicy({ context, draft })).toBe(
      "allow",
    );

    draft = restorePermissionDraftUnknown({ context, draft });

    expect(resolvePermissionDraftUnknownPolicy({ context, draft })).toBe(
      "deny",
    );
    expect(
      hasPermissionDraftResetPersistedEffect({
        context,
        draft,
        permissions: READ_PERMISSIONS,
        explicitGrants,
      }),
    ).toBe(false);
  });
});
