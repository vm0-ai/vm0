import type { FirewallPermissionDetailMetadata } from "@vm0/connectors/firewall-metadata";
import type { FirewallPolicies } from "@vm0/connectors/firewall-types";
import { describe, expect, it } from "vitest";

import {
  createEmptyPermissionDraftIntent,
  createPermissionDraftContext,
  materializePermissionDraftForLegacySave,
  resolvePermissionDraftExpiration,
  resolvePermissionDraftGroupExpiration,
  setPermissionDraftExpiration,
  setPermissionDraftGroupExpiration,
  setPermissionDraftGroupPolicy,
  setPermissionDraftPolicy,
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
});
