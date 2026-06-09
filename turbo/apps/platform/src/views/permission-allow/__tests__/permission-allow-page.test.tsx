import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserPermissionGrantsContract } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import { server } from "../../../mocks/server.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  createMockUserPermissionGrantResponse,
  setMockUserPermissionGrants,
} from "../../../mocks/handlers/api-user-permission-grants.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function mockAgent() {
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: AGENT_ID,
        ownerId: "test-user-123",
        description: null,
        displayName: "Research agent",
        sound: null,
        avatarUrl: null,
        customSkills: [],
      });
    }),
  );
}

function setupPermissionPage(path: string) {
  detachedSetupPage({
    context,
    path,
  });
}

function getButtonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((element) => {
    return element.textContent?.trim() === text;
  });
  expect(button).toBeDefined();
  return button!;
}

describe("permission allow page", () => {
  it("shows error when ref query param is missing", async () => {
    setupPermissionPage(`/agents/${AGENT_ID}/permissions`);

    await waitFor(() => {
      expect(
        screen.getByText("Missing permission in URL parameters"),
      ).toBeInTheDocument();
    });
  });

  it("shows error for unknown connector ref", async () => {
    setupPermissionPage(
      `/agents/${AGENT_ID}/permissions?ref=unknown-ref&permission=channels:read`,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Unknown connector: unknown-ref/),
      ).toBeInTheDocument();
    });
  });

  it("shows permissions updated when an allow grant already matches", async () => {
    mockAgent();
    setMockUserPermissionGrants([
      createMockUserPermissionGrantResponse({
        agentId: AGENT_ID,
        connectorRef: "slack",
        permission: "channels:read",
        action: "allow",
      }),
    ]);

    setupPermissionPage(
      `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=allow`,
    );

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
  });

  it("hides existing grant expiry when expiring grants are disabled", async () => {
    mockAgent();
    setMockUserPermissionGrants([
      createMockUserPermissionGrantResponse({
        agentId: AGENT_ID,
        connectorRef: "slack",
        permission: "users:read",
        action: "allow",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    ]);

    setupPermissionPage(
      `/agents/${AGENT_ID}/permissions?ref=slack&permission=users:read&action=allow`,
    );

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Expires in/)).not.toBeInTheDocument();
  });

  it("ignores expired matching grants", async () => {
    mockAgent();
    setMockUserPermissionGrants([
      createMockUserPermissionGrantResponse({
        agentId: AGENT_ID,
        connectorRef: "slack",
        permission: "chat:write",
        action: "allow",
        expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
      }),
    ]);

    setupPermissionPage(
      `/agents/${AGENT_ID}/permissions?ref=slack&permission=chat:write&action=allow`,
    );

    await waitFor(() => {
      expect(screen.getByText("Research agent")).toBeInTheDocument();
      expect(getButtonByText("Confirm")).toBeEnabled();
    });
  });

  it("writes a current-user grant from the confirm action", async () => {
    let grantBody: unknown;
    mockAgent();
    setMockUserPermissionGrants([]);
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBody = body;
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );

    setupPermissionPage(
      `/agents/${AGENT_ID}/permissions?ref=slack&permission=chat:write&action=allow`,
    );

    await waitFor(() => {
      expect(screen.getByText("Research agent")).toBeInTheDocument();
      expect(getButtonByText("Confirm")).toBeEnabled();
    });

    await click(getButtonByText("Confirm"));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
    expect(grantBody).toMatchObject({
      agentId: AGENT_ID,
      connectorRef: "slack",
      permission: "chat:write",
      action: "allow",
    });
    expect(grantBody).not.toMatchObject({ expiresIn: expect.any(String) });
  });

  it("submits the default duration when expiring grants are enabled", async () => {
    let grantBody: unknown;
    mockAgent();
    setMockUserPermissionGrants([]);
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBody = body;
        return respond(
          200,
          createMockUserPermissionGrantResponse({
            ...body,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
        );
      }),
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=chat:write&action=allow`,
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Research agent")).toBeInTheDocument();
      expect(
        screen.getByRole("combobox", { name: "Permission duration" }),
      ).toHaveTextContent("1 hour");
    });

    await click(getButtonByText("Confirm"));

    await waitFor(() => {
      expect(grantBody).toMatchObject({ expiresIn: "1h" });
    });
    expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    expect(screen.getByText("Expires in 1 hour")).toBeInTheDocument();
  });

  it("confirms a requested duration when an allow grant already matches", async () => {
    let grantBody: unknown;
    mockAgent();
    setMockUserPermissionGrants([
      createMockUserPermissionGrantResponse({
        agentId: AGENT_ID,
        connectorRef: "slack",
        permission: "chat:write",
        action: "allow",
      }),
    ]);
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBody = body;
        return respond(
          200,
          createMockUserPermissionGrantResponse({
            ...body,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
        );
      }),
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=chat:write&action=allow&expiresIn=1h`,
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Research agent")).toBeInTheDocument();
      expect(
        screen.getByRole("combobox", { name: "Permission duration" }),
      ).toHaveTextContent("1 hour");
      expect(getButtonByText("Confirm")).toBeEnabled();
    });

    await click(getButtonByText("Confirm"));

    await waitFor(() => {
      expect(grantBody).toMatchObject({ expiresIn: "1h" });
    });
    expect(screen.getByText("Permissions updated")).toBeInTheDocument();
  });

  it("treats requested always as already applied for permanent allow grants", async () => {
    mockAgent();
    setMockUserPermissionGrants([
      createMockUserPermissionGrantResponse({
        agentId: AGENT_ID,
        connectorRef: "slack",
        permission: "chat:write",
        action: "allow",
        expiresAt: null,
      }),
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=chat:write&action=allow&expiresIn=always`,
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("combobox", { name: "Permission duration" }),
    ).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").find((element) => {
        return element.textContent?.trim() === "Confirm";
      }),
    ).toBeUndefined();
  });

  it("confirms requested always when permission is allowed by an expiring unknown grant", async () => {
    mockAgent();
    setMockUserPermissionGrants([
      createMockUserPermissionGrantResponse({
        agentId: AGENT_ID,
        connectorRef: "slack",
        permission: UNKNOWN_PERMISSION_GRANT,
        action: "allow",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=chat:write&action=allow&expiresIn=always`,
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Research agent")).toBeInTheDocument();
      expect(
        screen.getByRole("combobox", { name: "Permission duration" }),
      ).toHaveTextContent("Always");
      expect(getButtonByText("Confirm")).toBeEnabled();
    });
  });

  it("submits the selected duration when expiring grants are enabled", async () => {
    let grantBody: unknown;
    mockAgent();
    setMockUserPermissionGrants([]);
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBody = body;
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=chat:write&action=allow`,
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });

    const durationSelect = await screen.findByRole("combobox", {
      name: "Permission duration",
    });
    click(durationSelect);
    click(await screen.findByRole("option", { name: "7 days" }));
    await click(getButtonByText("Confirm"));

    await waitFor(() => {
      expect(grantBody).toMatchObject({ expiresIn: "7d" });
    });
  });

  it("does not show or submit duration for deny grants", async () => {
    let grantBody: unknown;
    mockAgent();
    setMockUserPermissionGrants([]);
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBody = body;
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Research agent")).toBeInTheDocument();
      expect(
        screen.queryByRole("combobox", { name: "Permission duration" }),
      ).not.toBeInTheDocument();
    });

    await click(getButtonByText("Confirm"));

    await waitFor(() => {
      expect(grantBody).toMatchObject({
        permission: "channels:read",
        action: "deny",
      });
    });
    expect(grantBody).not.toMatchObject({ expiresIn: expect.any(String) });
    expect(screen.getByText("Permissions denied")).toBeInTheDocument();
    expect(screen.queryByText(/Expires in/)).not.toBeInTheDocument();
  });
});
