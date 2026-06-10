import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import {
  zeroUserPermissionGrantsContract,
  type UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const user = userEvent.setup();

describe("permission allow page", () => {
  it("lets a user grant an expiring connector permission to an agent", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000001";

    context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId,
        ownerId: "test-user-123",
        description: null,
        displayName: "Research Bot",
        sound: null,
        avatarUrl: null,
        customSkills: [],
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
    });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/permissions?ref=slack&permission=admin.analytics%3Aread&action=allow&expiresIn=24h`,
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
    expect(screen.getByText("Slack")).toBeInTheDocument();
    expect(
      screen.getByText("Access workspace analytics data"),
    ).toBeInTheDocument();
    expect(screen.getByText("admin.analytics:read")).toBeInTheDocument();
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
        customSkills: [],
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
    });
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, grants);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.upsert,
      ({ body, respond }) => {
        const grant: UserPermissionGrantResponse = {
          agentId: body.agentId,
          connectorRef: body.connectorRef,
          permission: body.permission,
          action: body.action,
          expiresAt: null,
          createdAt: grants[0]?.createdAt ?? "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:01:00Z",
        };
        grants = [grant];
        return respond(200, grant);
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

  it("shows the completed state when the requested grant already applies", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000003";

    context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId,
        ownerId: "test-user-123",
        description: null,
        displayName: "Audit Bot",
        sound: null,
        avatarUrl: null,
        customSkills: [],
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
          expiresAt: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:01:00Z",
        },
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/permissions?ref=slack&permission=admin.analytics%3Aread&action=allow&expiresIn=always`,
      user: {
        id: "test-user-123",
        fullName: "Taylor Reviewer",
        firstName: "Taylor",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
      expect(
        screen.queryByText("Hey Taylor, you're updating your permissions"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Confirm")).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/Expires in/u)).not.toBeInTheDocument();
  });

  it("shows a clear error for an unknown connector permission URL", async () => {
    detachedSetupPage({
      context,
      path: `/agents/c0000000-0000-4000-a000-000000000404/permissions?ref=not-a-connector&permission=admin.analytics%3Aread&action=allow`,
      user: {
        id: "test-user-123",
        fullName: "Casey Operator",
        firstName: "Casey",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Unknown connector: not-a-connector"),
      ).toBeInTheDocument();
    });
  });
});
