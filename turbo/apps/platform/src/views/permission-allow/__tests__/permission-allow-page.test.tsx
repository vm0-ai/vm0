import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogPermissionDetail,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  zeroUserPermissionGrantsContract,
  type UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { isoFromNowMs, mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const user = userEvent.setup();

function catalogPermissionDetail(
  overrides: Partial<PublicConnectorCatalogPermissionDetail> &
    Pick<
      PublicConnectorCatalogPermissionDetail,
      "connectorRef" | "label" | "permissions"
    >,
): PublicConnectorCatalogPermissionDetail {
  const { connectorRef, label, permissions, ...rest } = overrides;
  return {
    connectorRef,
    label,
    permissionCount: permissions.length,
    permissions,
    categories: null,
    defaultPolicy: {
      permissionDefault: "ask",
      unknownPolicy: "ask",
    },
    ...rest,
  };
}

describe("permission allow page", () => {
  it("rejects unsupported permission actions instead of defaulting to allow", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000000";

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/permissions?ref=slack&permission=admin.analytics%3Aread&action=approve`,
      user: {
        id: "test-user-123",
        fullName: "Dana Analyst",
        firstName: "Dana",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Unknown permission action: approve"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Confirm")).not.toBeInTheDocument();
  });

  it("lets a user grant an expiring connector permission to an agent", async () => {
    mockNow();
    const agentId = "c0000000-0000-4000-a000-000000000001";
    let capturedBody: unknown = null;

    context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId,
        ownerId: "test-user-123",
        description: null,
        displayName: "Research Bot",
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
    });
    context.mocks.api(
      zeroConnectorCatalogContract.permissions,
      ({ params, respond }) => {
        expect(params.connectorRef).toBe("slack");
        return respond(200, {
          permissions: catalogPermissionDetail({
            connectorRef: "slack",
            label: "Catalog Slack",
            permissions: [
              {
                name: "catalog.analytics:read",
                description: "Catalog analytics access",
              },
            ],
          }),
        });
      },
    );
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        capturedBody = body;
        const appliedGrant = body.grants[0];
        if (!appliedGrant) {
          throw new Error("Expected a permission grant");
        }
        return respond(200, [
          {
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: appliedGrant.permission,
            action: appliedGrant.action,
            expiresAt: isoFromNowMs(24 * 60 * 60 * 1000),
            createdAt: "2026-03-10T00:00:00.000Z",
            updatedAt: "2026-03-10T00:01:00.000Z",
          },
        ]);
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/permissions?ref=slack&permission=catalog.analytics%3Aread&action=allow&expiresIn=24h`,
      user: {
        id: "test-user-123",
        fullName: "Dana Analyst",
        firstName: "Dana",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText(
          "Hey Dana, you're updating your permissions for Research Bot.",
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Research Bot")).toBeInTheDocument();
    expect(screen.getByText("Catalog Slack")).toBeInTheDocument();
    expect(screen.getByText("Catalog analytics access")).toBeInTheDocument();
    expect(screen.getByText("catalog.analytics:read")).toBeInTheDocument();
    expect(screen.getByText("Duration")).toBeInTheDocument();
    expect(screen.getByText("24 hours")).toBeInTheDocument();

    await user.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Your connector permission grant has been updated"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Expires in (1 day|24 hours)/)).toBeInTheDocument();
    expect(capturedBody).toMatchObject({
      agentId,
      connectorRef: "slack",
      mode: "patch",
      grants: [
        {
          permission: "catalog.analytics:read",
          action: "allow",
          expiresIn: "24h",
        },
      ],
    });
  });

  it("fails closed when catalog permissions returns not found", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000009";

    context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId,
        ownerId: "test-user-123",
        description: null,
        displayName: "Hidden Connector Bot",
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
    });
    context.mocks.api(
      zeroConnectorCatalogContract.permissions,
      ({ respond }) => {
        return respond(404, {
          error: { message: "Connector not found", code: "NOT_FOUND" },
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/permissions?ref=hidden-connector&permission=hidden.permission&action=allow`,
      user: {
        id: "test-user-123",
        fullName: "Dana Analyst",
        firstName: "Dana",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Unknown connector: hidden-connector"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Confirm")).not.toBeInTheDocument();
  });

  it("lets a user deny a connector permission without an expiry choice", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000002";
    let grants: UserPermissionGrantResponse[] = [
      {
        agentId,
        connectorRef: "slack",
        permission: "admin.analytics:read",
        action: "allow",
        expiresAt: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ];

    context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId,
        ownerId: "test-user-123",
        description: null,
        displayName: "Ops Bot",
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
    });
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, grants);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        const appliedGrant = body.grants[0];
        if (!appliedGrant) {
          throw new Error("Expected a permission grant");
        }
        expect(body.mode).toBe("patch");
        const grant: UserPermissionGrantResponse = {
          agentId: body.agentId,
          connectorRef: body.connectorRef,
          permission: appliedGrant.permission,
          action: appliedGrant.action,
          expiresAt: null,
          createdAt: grants[0]?.createdAt ?? "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:01:00Z",
        };
        grants = [grant];
        return respond(200, [grant]);
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/permissions?ref=slack&permission=admin.analytics%3Aread&action=deny`,
      user: {
        id: "test-user-123",
        fullName: "Morgan Operator",
        firstName: "Morgan",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText(
          "Hey Morgan, you're updating your permissions for Ops Bot.",
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Slack")).toBeInTheDocument();
    expect(
      screen.getByText("Access workspace analytics data"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Duration")).not.toBeInTheDocument();

    await user.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(screen.getByText("Permissions denied")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Your connector permission grant has been denied"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Expires in/u)).not.toBeInTheDocument();
  });

  it("shows already allowed when the permission is already granted with a different expiry", async () => {
    mockNow();
    const agentId = "c0000000-0000-4000-a000-000000000003";

    context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId,
        ownerId: "test-user-123",
        description: null,
        displayName: "Audit Bot",
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
    });
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, [
        {
          agentId,
          connectorRef: "slack",
          permission: "admin.analytics:read",
          action: "allow",
          expiresAt: isoFromNowMs(7 * 24 * 60 * 60 * 1000),
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:01:00Z",
        },
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/permissions?ref=slack&permission=admin.analytics%3Aread&action=allow&expiresIn=24h`,
      user: {
        id: "test-user-123",
        fullName: "Taylor Reviewer",
        firstName: "Taylor",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Already allowed")).toBeInTheDocument();
      expect(
        screen.queryByText(/Hey Taylor, you're updating your permissions/u),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Confirm")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Expires in 7 days")).toBeInTheDocument();
    expect(screen.queryByText("Duration")).not.toBeInTheDocument();
  });

  it("shows already denied when the permission is already denied", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000006";

    context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId,
        ownerId: "test-user-123",
        description: null,
        displayName: "Review Bot",
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
    });
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, [
        {
          agentId,
          connectorRef: "slack",
          permission: "admin.analytics:read",
          action: "deny",
          expiresAt: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:01:00Z",
        },
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/permissions?ref=slack&permission=admin.analytics%3Aread&action=deny`,
      user: {
        id: "test-user-123",
        fullName: "Jordan Reviewer",
        firstName: "Jordan",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Already denied")).toBeInTheDocument();
      expect(
        screen.queryByText(/Hey Jordan, you're updating your permissions/u),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Confirm")).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/Expires in/u)).not.toBeInTheDocument();
    expect(screen.queryByText("Duration")).not.toBeInTheDocument();
  });

  it("lets a user grant unknown endpoints to an agent", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000004";
    let grants: UserPermissionGrantResponse[] = [];

    context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId,
        ownerId: "test-user-123",
        description: null,
        displayName: "Cloudflare Bot",
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
    });
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, grants);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        const appliedGrant = body.grants[0];
        if (!appliedGrant) {
          throw new Error("Expected a permission grant");
        }
        expect(body.mode).toBe("patch");
        const grant: UserPermissionGrantResponse = {
          agentId: body.agentId,
          connectorRef: body.connectorRef,
          permission: appliedGrant.permission,
          action: appliedGrant.action,
          expiresAt: "2026-03-10T01:00:00Z",
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:01:00Z",
        };
        grants = [grant];
        return respond(200, [grant]);
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/permissions?ref=cloudflare&permission=__unknown__&action=allow&expiresIn=1h`,
      user: {
        id: "test-user-123",
        fullName: "Casey Reviewer",
        firstName: "Casey",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText(
          "Hey Casey, you're updating your permissions for Cloudflare Bot.",
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Cloudflare")).toBeInTheDocument();
    expect(screen.getByText("Unknown endpoints")).toBeInTheDocument();
    expect(screen.getByText(UNKNOWN_PERMISSION_GRANT)).toBeInTheDocument();

    await user.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
    expect(grants).toMatchObject([
      {
        agentId,
        connectorRef: "cloudflare",
        permission: UNKNOWN_PERMISSION_GRANT,
        action: "allow",
      },
    ]);
  });

  it("shows the completed state when an unknown endpoint grant already applies", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000005";

    context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId,
        ownerId: "test-user-123",
        description: null,
        displayName: "Edge Bot",
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
    });
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, [
        {
          agentId,
          connectorRef: "cloudflare",
          permission: UNKNOWN_PERMISSION_GRANT,
          action: "allow",
          expiresAt: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:01:00Z",
        },
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/permissions?ref=cloudflare&permission=__unknown__&action=allow&expiresIn=always`,
      user: {
        id: "test-user-123",
        fullName: "Riley Reviewer",
        firstName: "Riley",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Already allowed")).toBeInTheDocument();
      expect(
        screen.queryByText(/Hey Riley, you're updating your permissions/u),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Confirm")).not.toBeInTheDocument();
    });
  });

  it("shows a load error without a confirm action", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000007";

    context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId,
        ownerId: "test-user-123",
        description: null,
        displayName: "Load Error Bot",
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
    });
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "Forbidden",
        },
      });
    });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/permissions?ref=slack&permission=admin.analytics%3Aread&action=allow&expiresIn=24h`,
      user: {
        id: "test-user-123",
        fullName: "Avery Reviewer",
        firstName: "Avery",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Failed to load permission grants"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Confirm")).not.toBeInTheDocument();
  });

  it("keeps the permission form visible after a save failure", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000008";

    context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId,
        ownerId: "test-user-123",
        description: null,
        displayName: "Save Error Bot",
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
    });
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, []);
    });
    context.mocks.api(zeroUserPermissionGrantsContract.apply, ({ respond }) => {
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "Forbidden",
        },
      });
    });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/permissions?ref=slack&permission=admin.analytics%3Aread&action=allow&expiresIn=24h`,
      user: {
        id: "test-user-123",
        fullName: "Quinn Reviewer",
        firstName: "Quinn",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText(
          "Hey Quinn, you're updating your permissions for Save Error Bot.",
        ),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(
        screen.getByText("Couldn't update permissions"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Hey Quinn, you're updating your permissions for Save Error Bot.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("admin.analytics:read")).toBeInTheDocument();
    expect(screen.getByText("Confirm")).toBeEnabled();
    expect(screen.queryByText("Permissions updated")).not.toBeInTheDocument();
  });
});
