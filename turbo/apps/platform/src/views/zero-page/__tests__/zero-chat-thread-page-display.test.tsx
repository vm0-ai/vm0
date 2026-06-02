import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { hasSubscription, triggerAblyEvent } from "../../../mocks/ably.ts";
import { updateChatArtifacts } from "../../../mocks/mock-helpers.ts";
import {
  chatMessagesContract,
  chatThreadArtifactsContract,
  chatThreadGithubPrsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  permissionAccessRequestsCreateContract,
  permissionAccessRequestsListContract,
  type PermissionAccessRequestResponse,
  zeroAgentPermissionPoliciesContract,
  zeroAgentsByIdContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserPermissionGrantsContract } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { zeroConnectorOauthStartContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import { setMockOrg } from "../../../mocks/handlers/api-org.ts";
import { setMockPermissionRequests } from "../../../mocks/handlers/api-permission-access-requests.ts";
import {
  createMockUserPermissionGrantResponse,
  setMockUserPermissionGrants,
} from "../../../mocks/handlers/api-user-permission-grants.ts";
import {
  createDefaultMockGithubIntegration,
  setMockGithubIntegration,
} from "../../../mocks/handlers/api-integrations-github.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

function queryRoleByText(
  role: Parameters<typeof queryAllByRoleFast>[0],
  text: string,
): HTMLElement | undefined {
  return queryAllByRoleFast(role).find((element) => {
    return element.textContent?.trim() === text;
  });
}

function getRoleByText(
  role: Parameters<typeof queryAllByRoleFast>[0],
  text: string,
): HTMLElement {
  const element = queryRoleByText(role, text);
  expect(element).toBeDefined();
  return element!;
}

function queryRoleByAriaLabel(
  role: Parameters<typeof queryAllByRoleFast>[0],
  label: string,
): HTMLElement | undefined {
  return queryAllByRoleFast(role).find((element) => {
    return element.getAttribute("aria-label") === label;
  });
}

function mockConnectorOauthStart() {
  server.use(
    mockApi(zeroConnectorOauthStartContract.start, ({ params, respond }) => {
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.type}/authorize`,
      });
    }),
  );
}

function createMockAuthWindow() {
  return { closed: false, close: vi.fn(), location: { href: "" } };
}

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", "https://www.vm0.ai");
  vi.stubEnv("PUBLIC_ARTIFACTS_BASE_URL", "https://cdn.vm7.io");
  server.use(
    http.get("https://example.com/avatar.png", () => {
      return new HttpResponse("avatar", {
        headers: { "Content-Type": "image/png" },
      });
    }),
  );
});

describe("zero chat thread page display - permission action card", () => {
  function pendingPermissionRequest(
    overrides: Partial<PermissionAccessRequestResponse> = {},
  ): PermissionAccessRequestResponse {
    return {
      id: "d0000000-0000-4000-a000-000000000001",
      agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
      connectorRef: "vercel",
      permission: "projects:write",
      action: "allow",
      method: null,
      path: null,
      reason: "Need access",
      status: "pending",
      requesterUserId: "test-user-123",
      requesterName: "Test User",
      resolvedBy: null,
      resolvedAt: null,
      createdAt: "2026-03-10T00:00:00Z",
      ...overrides,
    };
  }

  it("executes permission URLs as permission actions for agent owners", async () => {
    let updatedPolicies: unknown;

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=vercel&permission=projects%3Awrite&action=allow",
          runId: "run-permission-action",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: {
            vercel: { policies: { "projects:write": "deny" } },
          },
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
      mockApi(
        zeroAgentPermissionPoliciesContract.update,
        ({ body, respond }) => {
          updatedPolicies = body.policies;
          return respond(200, {
            agentId: body.agentId,
            ownerId: "test-user-123",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            permissionPolicies: body.policies,
            customSkills: [],
            modelProviderId: null,
            selectedModel: null,
            preferPersonalProvider: false,
          });
        },
      ),
    );

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    expect(within(card).getByText("Vercel permissions")).toBeInTheDocument();
    expect(within(card).getByText("Allow projects:write")).toBeInTheDocument();
    click(await within(card).findByText("Confirm"));

    await waitFor(() => {
      expect(updatedPolicies).toStrictEqual({
        vercel: { policies: { "projects:write": "allow" } },
      });
    });
    const status = within(card).getByText("Permissions updated");
    expect(status).toBeInTheDocument();
    expect(status.closest("button")).toBeNull();
  });

  it("lets org admins confirm permission actions for agents they do not own", async () => {
    let updatedPolicies: unknown;

    setMockOrg({ role: "admin" });
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=vercel&permission=projects%3Awrite&action=allow",
          runId: "run-permission-action-admin-non-owner",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "other-owner-id",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: {
            vercel: { policies: { "projects:write": "deny" } },
          },
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
      mockApi(
        zeroAgentPermissionPoliciesContract.update,
        ({ body, respond }) => {
          updatedPolicies = body.policies;
          return respond(200, {
            agentId: body.agentId,
            ownerId: "other-owner-id",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            permissionPolicies: body.policies,
            customSkills: [],
            modelProviderId: null,
            selectedModel: null,
            preferPersonalProvider: false,
          });
        },
      ),
    );

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    expect(within(card).getByText("Confirm")).toBeInTheDocument();
    expect(
      within(card).queryByText("Request approval"),
    ).not.toBeInTheDocument();
    click(await within(card).findByText("Confirm"));

    await waitFor(() => {
      expect(updatedPolicies).toStrictEqual({
        vercel: { policies: { "projects:write": "allow" } },
      });
    });
  });

  it("offers Confirm when the requested permission has no explicit stored policy", async () => {
    let updatedPolicies: unknown;

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=vercel&permission=dns%3Aread&action=allow",
          runId: "run-permission-action-defaulted",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: {
            vercel: { policies: { "projects:write": "deny" } },
          },
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
      mockApi(
        zeroAgentPermissionPoliciesContract.update,
        ({ body, respond }) => {
          updatedPolicies = body.policies;
          return respond(200, {
            agentId: body.agentId,
            ownerId: "test-user-123",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            permissionPolicies: body.policies,
            customSkills: [],
            modelProviderId: null,
            selectedModel: null,
            preferPersonalProvider: false,
          });
        },
      ),
    );

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    expect(within(card).getByText("Vercel permissions")).toBeInTheDocument();
    expect(within(card).getByText("Allow dns:read")).toBeInTheDocument();

    expect(
      within(card).queryByText("Permissions updated"),
    ).not.toBeInTheDocument();
    const confirm = await within(card).findByText("Confirm");
    expect(confirm).toBeEnabled();
    click(confirm);

    await waitFor(() => {
      expect(updatedPolicies).toStrictEqual({
        vercel: {
          policies: { "projects:write": "deny", "dns:read": "allow" },
        },
      });
    });
    expect(within(card).getByText("Permissions updated")).toBeInTheDocument();
  });

  it("rejects unknown permissions before updating policies", async () => {
    let updateCalled = false;

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=vercel&permission=unknown%3Apermission&action=allow",
          runId: "run-unknown-permission-action",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: {
            vercel: { policies: { "projects:write": "deny" } },
          },
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
      mockApi(
        zeroAgentPermissionPoliciesContract.update,
        ({ body, respond }) => {
          updateCalled = true;
          return respond(200, {
            agentId: body.agentId,
            ownerId: "test-user-123",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            permissionPolicies: body.policies,
            customSkills: [],
            modelProviderId: null,
            selectedModel: null,
            preferPersonalProvider: false,
          });
        },
      ),
    );

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    const button = queryAllByRoleFast("button", card).find((element) => {
      return element.textContent === "Unknown permission";
    });
    expect(button).toBeDefined();
    expect(button).toBeDisabled();

    click(button!);

    expect(updateCalled).toBeFalsy();
  });

  it("does not create duplicate requests when a member already has a request", async () => {
    let createCalled = false;

    setMockOrg({ role: "member" });
    setMockPermissionRequests([pendingPermissionRequest()]);
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=vercel&permission=projects%3Awrite&action=allow",
          runId: "run-existing-permission-request",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "other-owner-id",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: {
            vercel: { policies: { "projects:write": "deny" } },
          },
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
      mockApi(permissionAccessRequestsCreateContract.create, ({ respond }) => {
        createCalled = true;
        return respond(201, pendingPermissionRequest());
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    await waitFor(() => {
      expect(within(card).getByText("Request sent")).toBeInTheDocument();
    });
    expect(within(card).getByText("Request sent").closest("button")).toBeNull();
    expect(
      queryAllByRoleFast("button", card).some((element) => {
        return element.textContent === "Request sent";
      }),
    ).toBeFalsy();

    expect(createCalled).toBeFalsy();
  });

  it("refreshes a requested permission action when the Ably signal arrives", async () => {
    let requestBody: unknown;
    let agentPolicies: Record<
      string,
      { policies: Record<string, "allow" | "deny"> }
    > = {
      vercel: { policies: { "projects:write": "deny" } },
    };
    const pendingRequest = pendingPermissionRequest();

    setMockOrg({ role: "member" });
    setMockPermissionRequests([]);
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=vercel&permission=projects%3Awrite&action=allow",
          runId: "run-permission-request-refresh",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "other-owner-id",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: agentPolicies,
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
      mockApi(
        permissionAccessRequestsCreateContract.create,
        ({ body, respond }) => {
          requestBody = body;
          setMockPermissionRequests([pendingRequest]);
          return respond(201, pendingRequest);
        },
      ),
    );

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    expect(hasSubscription("permissionAccessRequestsChanged")).toBeFalsy();
    click(await within(card).findByText("Request approval"));

    await waitFor(() => {
      expect(requestBody).toMatchObject({
        agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
        connectorRef: "vercel",
        permission: "projects:write",
        action: "allow",
      });
    });
    await waitFor(() => {
      expect(within(card).getByText("Request sent")).toBeInTheDocument();
    });
    expect(within(card).getByText("Request sent").closest("button")).toBeNull();
    await waitFor(() => {
      expect(hasSubscription("permissionAccessRequestsChanged")).toBeTruthy();
    });

    agentPolicies = {
      vercel: { policies: { "projects:write": "allow" } },
    };
    setMockPermissionRequests([
      pendingPermissionRequest({
        id: pendingRequest.id,
        status: "approved",
        resolvedBy: "other-owner-id",
        resolvedAt: "2026-03-10T00:01:00Z",
      }),
    ]);
    triggerAblyEvent("permissionAccessRequestsChanged");

    await waitFor(() => {
      expect(within(card).getByText("Permissions updated")).toBeInTheDocument();
    });
  });

  it("writes a current-user grant for members when user permission grants are enabled", async () => {
    let grantBody: unknown;
    let requestCreated = false;
    let requestsListed = false;

    setMockOrg({ role: "member" });
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=slack&permission=channels%3Awrite&action=allow",
          runId: "run-user-grant-permission-action",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "other-owner-id",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: {
            slack: { policies: { "channels:write": "deny" } },
          },
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBody = body;
        return respond(
          200,
          createMockUserPermissionGrantResponse({
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: body.permission,
            action: body.action,
          }),
        );
      }),
      mockApi(permissionAccessRequestsCreateContract.create, ({ respond }) => {
        requestCreated = true;
        return respond(201, pendingPermissionRequest());
      }),
      mockApi(permissionAccessRequestsListContract.list, ({ respond }) => {
        requestsListed = true;
        return respond(200, []);
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.UserPermissionGrants]: true },
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    expect(hasSubscription("permissionAccessRequestsChanged")).toBeFalsy();
    click(await within(card).findByText("Confirm"));

    await waitFor(() => {
      expect(grantBody).toMatchObject({
        agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
        connectorRef: "slack",
        permission: "channels:write",
        action: "allow",
      });
    });
    expect(requestCreated).toBeFalsy();
    expect(requestsListed).toBeFalsy();
    expect(hasSubscription("permissionAccessRequestsChanged")).toBeFalsy();
    expect(within(card).getByText("Permissions updated")).toBeInTheDocument();
  });

  it("writes a current-user grant for admins when user permission grants are enabled", async () => {
    let grantBody: unknown;
    let policyUpdated = false;

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=vercel&permission=projects%3Awrite&action=deny",
          runId: "run-admin-user-grant-permission-action",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: {
            vercel: { policies: { "projects:write": "allow" } },
          },
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBody = body;
        return respond(
          200,
          createMockUserPermissionGrantResponse({
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: body.permission,
            action: body.action,
          }),
        );
      }),
      mockApi(zeroAgentPermissionPoliciesContract.update, ({ respond }) => {
        policyUpdated = true;
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: {
            vercel: { policies: { "projects:write": "deny" } },
          },
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.UserPermissionGrants]: true },
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    click(await within(card).findByText("Confirm"));

    await waitFor(() => {
      expect(grantBody).toMatchObject({
        agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
        connectorRef: "vercel",
        permission: "projects:write",
        action: "deny",
      });
    });
    expect(policyUpdated).toBeFalsy();
    expect(within(card).getByText("Permission denied")).toBeInTheDocument();
  });

  it("uses default connector policies for already-applied chat permission actions", async () => {
    let grantCalled = false;

    setMockOrg({ role: "member" });
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=slack&permission=channels%3Aread&action=allow",
          runId: "run-user-grant-permission-default-applied",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "other-owner-id",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: {
            slack: { policies: { "channels:read": "deny" } },
          },
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantCalled = true;
        return respond(
          200,
          createMockUserPermissionGrantResponse({
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: body.permission,
            action: body.action,
          }),
        );
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.UserPermissionGrants]: true },
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    expect(within(card).getByText("Permissions updated")).toBeInTheDocument();
    expect(grantCalled).toBeFalsy();
  });

  it("uses current-user grants for already-applied chat permission actions", async () => {
    setMockOrg({ role: "member" });
    setMockUserPermissionGrants([
      createMockUserPermissionGrantResponse({
        agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
        connectorRef: "slack",
        permission: "channels:write",
        action: "allow",
      }),
    ]);
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=slack&permission=channels%3Awrite&action=allow",
          runId: "run-user-grant-permission-action-applied",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "other-owner-id",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: {
            slack: { policies: { "channels:write": "deny" } },
          },
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.UserPermissionGrants]: true },
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    expect(within(card).getByText("Permissions updated")).toBeInTheDocument();
    const button = queryAllByRoleFast("button", card).find((element) => {
      return element.textContent === "Permissions updated";
    });
    expect(button).toBeDefined();
    expect(button).toBeDisabled();
  });

  it("does not write grants for unknown chat permission actions", async () => {
    let grantCalled = false;

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=vercel&permission=unknown%3Apermission&action=allow",
          runId: "run-user-grant-unknown-permission-action",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: {
            vercel: { policies: { "projects:write": "deny" } },
          },
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantCalled = true;
        return respond(
          200,
          createMockUserPermissionGrantResponse({
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: body.permission,
            action: body.action,
          }),
        );
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.UserPermissionGrants]: true },
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    const button = queryAllByRoleFast("button", card).find((element) => {
      return element.textContent === "Unknown permission";
    });
    expect(button).toBeDefined();
    expect(button).toBeDisabled();

    click(button!);

    expect(grantCalled).toBeFalsy();
  });

  it("disables chat permission actions when current-user grants fail to load", async () => {
    let grantCalled = false;

    setMockOrg({ role: "member" });
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=slack&permission=channels%3Aread&action=allow",
          runId: "run-user-grant-load-failed",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "other-owner-id",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: {
            slack: { policies: { "channels:read": "deny" } },
          },
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
      mockApi(zeroUserPermissionGrantsContract.list, ({ respond }) => {
        return respond(404, {
          error: { message: "Agent not found", code: "NOT_FOUND" },
        });
      }),
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantCalled = true;
        return respond(
          200,
          createMockUserPermissionGrantResponse({
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: body.permission,
            action: body.action,
          }),
        );
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.UserPermissionGrants]: true },
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    const button = queryAllByRoleFast("button", card).find((element) => {
      return element.textContent === "Failed to load permissions";
    });
    expect(button).toBeDefined();
    expect(button).toBeDisabled();

    click(button!);

    expect(grantCalled).toBeFalsy();
  });
});

// CHAT-D-036: Attachment image previews render in ChatMessageRow
describe("zero chat thread page display - attachment image preview", () => {
  it("renders image attachment preview with the correct alt text", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content:
            "[Attached file: photo.png](https://example.com/photo.png)\nDownload with: curl https://example.com/photo.png\n",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const previewLink = await waitFor(() => {
      return screen.getByLabelText("Preview photo.png");
    });
    expect(previewLink).toHaveAttribute(
      "href",
      "https://example.com/photo.png",
    );
    const previewImage = within(previewLink).getByAltText("photo.png");
    expect(previewImage).toBeInTheDocument();
    expect(
      within(previewLink).getByTestId("chat-image-preview-loading"),
    ).toBeInTheDocument();

    fireEvent.load(previewImage);
    await waitFor(() => {
      expect(
        within(previewLink).queryByTestId("chat-image-preview-loading"),
      ).not.toBeInTheDocument();
    });
  });
});

describe("zero chat thread page display - attachment audio chip", () => {
  it("renders audio attachment as a compact download chip", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Please listen",
          createdAt: "2026-03-10T00:00:00Z",
          attachFiles: [
            {
              id: "audio-file-1",
              filename: "clip.mp3",
              contentType: "audio/mpeg",
              size: 4096,
              url: "https://example.com/clip.mp3",
            },
          ],
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const download = await waitFor(() => {
      return screen.getByLabelText("Download clip.mp3");
    });
    expect(download).toHaveAttribute("type", "button");
    expect(download).not.toHaveAttribute("href");
    expect(
      within(download).getByTestId("attachment-chip-file-icon"),
    ).toBeInTheDocument();
  });
});

// CHAT-D-037: Attachment document previews render in ChatMessageRow
describe("zero chat thread page display - attachment document preview", () => {
  it("keeps markdown attachments as chips and opens preview on click", async () => {
    const docUrl = "https://example.com/notes.md#intro";
    let requestedUrl = "";
    let requestedRange = "";
    server.use(
      http.get("https://example.com/notes.md", ({ request }) => {
        requestedUrl = request.url;
        requestedRange = request.headers.get("Range") ?? "";
        return HttpResponse.text("# PRD\n\nPreview body");
      }),
    );

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: notes.md](${docUrl})\nDownload with: curl ${docUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open markdown preview for notes.md"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open markdown preview for notes.md"),
    );

    await waitFor(() => {
      expect(screen.getByText("PRD")).toBeInTheDocument();
      expect(screen.getByText("Preview body")).toBeInTheDocument();
    });
    expect(new URL(requestedUrl).searchParams.get("raw")).toBeNull();
    expect(requestedRange).toBe("bytes=0-65535");
  });
});

describe("zero chat thread page display - body link document preview", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "location",
      new URL("https://app.vm0.ai/chats/thread-test-1"),
    );
  });

  it("renders markdown body links inline for platform file urls", async () => {
    const docUrl =
      "https://api.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/notes.md";
    server.use(
      http.get(docUrl, () => {
        return HttpResponse.text("# Linked PRD\n\nPreview body");
      }),
    );

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[可爱文档](${docUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByTestId("attachment-preview-markdown"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open markdown preview for notes.md"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open markdown preview for notes.md"),
    );

    await waitFor(() => {
      expect(screen.getByText("Linked PRD")).toBeInTheDocument();
      expect(screen.getByText("Preview body")).toBeInTheDocument();
    });
  });

  it("keeps external markdown links as plain links and does not render preview cards", async () => {
    const docUrl = "https://example.com/notes.md";

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[notes](${docUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByText("notes")).toBeInTheDocument();
    });

    expect(
      screen.queryByTestId("attachment-preview-markdown"),
    ).not.toBeInTheDocument();
  });

  it("keeps external /f links as plain links and does not render preview cards", async () => {
    const docUrl =
      "https://example.com/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/notes.md";

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[notes](${docUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByText("notes").closest("a")).toHaveAttribute(
        "href",
        docUrl,
      );
    });

    expect(
      screen.queryByTestId("attachment-preview-markdown"),
    ).not.toBeInTheDocument();
  });

  it.each(["vm0.ai", "vm6.ai", "vm7.ai"])(
    "renders %s file host links as thumbnail preview blocks",
    async (host) => {
      const fileUrl = `https://www.${host}/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/test_files.zip`;

      mockChatLifecycle({
        chatMessages: [
          {
            role: "assistant",
            content: `[test_files.zip](${fileUrl})`,
            createdAt: "2026-03-10T00:00:00Z",
          },
        ],
      });

      detachedSetupPage({ context, path: "/chats/thread-test-1" });

      const preview = await screen.findByTestId("attachment-preview-file");
      expect(
        within(preview).getByTestId("attachment-preview-file-icon"),
      ).toBeInTheDocument();
      expect(within(preview).getByText("ZIP")).toBeInTheDocument();
    },
  );

  it("renders matching tunnel host file links as thumbnail preview blocks", async () => {
    vi.stubGlobal(
      "location",
      new URL("https://tunnel-yuma-vm0-app.vm7.ai/chats/thread-test-1"),
    );
    const fileUrl =
      "https://tunnel-yuma-vm0-www.vm7.ai/f/user_3BennfUepyJwP3OaiYD0rK8CZKs/bce0a522-aed9-4d72-a86c-3164177fb44c/test_files.zip";

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[test_files.zip](${fileUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const preview = await screen.findByTestId("attachment-preview-file");
    expect(
      within(preview).getByTestId("attachment-preview-file-icon"),
    ).toBeInTheDocument();
    expect(within(preview).getByText("ZIP")).toBeInTheDocument();
    const download = screen.getByLabelText("Download test_files.zip");
    expect(download).toHaveAttribute("type", "button");
    expect(download).not.toHaveAttribute("href");
  });

  it("keeps platform file links inside markdown tables as table links", async () => {
    const docUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/budget.xlsx";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: [
            "| File | Link |",
            "| --- | --- |",
            `| Budget | [budget.xlsx](${docUrl}) |`,
          ].join("\n"),
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const table = await screen.findByRole("table");
    expect(within(table).getByText("budget.xlsx").closest("a")).toHaveAttribute(
      "href",
      docUrl,
    );
    expect(screen.queryByTestId("attachment-preview-file")).toBeNull();
  });

  it("renders html body links as preview cards for platform file urls", async () => {
    const htmlUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/report.html";
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>report preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[可爱小猫页面](${htmlUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-html")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open html preview for 可爱小猫页面"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open html preview for 可爱小猫页面"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("可爱小猫页面 preview")).toBeInTheDocument();
    });
  });

  it("renders html body links wrapped in markdown formatting as preview cards for platform file urls", async () => {
    const htmlUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/cute_kitten.html";
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>kitten preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `上传完成！点击下面的链接即可查看：\n\n**[可爱小猫页面](${htmlUrl})**\n\n页面包含居中卡片布局。`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-html")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open html preview for 可爱小猫页面"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open html preview for 可爱小猫页面"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("可爱小猫页面 preview")).toBeInTheDocument();
    });
  });

  it("renders bold bare html urls as preview cards and preserves surrounding text", async () => {
    const htmlUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/diabetes.html";
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>diabetes preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `已上传，直接访问即可：\n\n**${htmlUrl}**\n\n页面包含了血糖换算器、诊断标准表、饮食建议。`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByText("已上传，直接访问即可：")).toBeInTheDocument();
      expect(screen.getByTestId("attachment-preview-html")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open html preview for diabetes.html"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("页面包含了血糖换算器、诊断标准表、饮食建议。"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open html preview for diabetes.html"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("diabetes.html preview")).toBeInTheDocument();
    });
  });

  it("renders platform file urls inside markdown list and quote symbols as preview cards", async () => {
    const htmlUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/symbol-report.html";
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>symbol preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `文件已生成：\n\n> 👉 **<${htmlUrl}>**\n\n- **[查看报告](${htmlUrl})**`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getAllByTestId("attachment-preview-html")).toHaveLength(2);
      expect(
        screen.getByLabelText("Open html preview for symbol-report.html"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open html preview for 查看报告"),
      ).toBeInTheDocument();
    });
  });

  it("renders bare platform image file urls as image previews", async () => {
    const user = userEvent.setup();
    const imageUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/chart.png";
    const publicImageUrl =
      "https://cdn.vm7.io/artifacts/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/chart.png";
    server.use(
      http.get(imageUrl, () => {
        return new HttpResponse("png", {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `生成完成：\n\n${imageUrl}`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByLabelText("Preview chart.png")).toBeInTheDocument();
    });
    const previewLink = screen.getByLabelText("Preview chart.png");
    expect(previewLink).toHaveAttribute("href", publicImageUrl);
    expect(within(previewLink).getByAltText("chart.png")).toBeInTheDocument();

    await user.click(previewLink);
    const lightbox = await screen.findByTestId("attachment-lightbox");
    expect(lightbox).toBeInTheDocument();
  });

  it("renders json body links inline and supports collapse for platform file urls", async () => {
    const jsonUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/data.json";
    server.use(
      http.get(jsonUrl, () => {
        return HttpResponse.text('{"status":"ok","count":2}');
      }),
    );

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[数据](${jsonUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-json")).toBeInTheDocument();
      expect(screen.getByText(/"status": "ok"/)).toBeInTheDocument();
      expect(screen.getByText(/"count": 2/)).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Collapse json preview for data.json"),
    );

    await waitFor(() => {
      expect(screen.queryByText(/"status": "ok"/)).not.toBeInTheDocument();
    });
  });

  it("renders pdf body links as previewable document cards for platform file urls", async () => {
    const pdfUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/document.pdf";
    server.use(
      http.get(pdfUrl, () => {
        return new HttpResponse("%PDF-1.4", {
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[手册](${pdfUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-pdf")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open pdf preview for document.pdf"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open pdf preview for document.pdf"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("document.pdf preview")).toBeInTheDocument();
    });
  });

  it("renders csv body links as previewable document cards for platform file urls", async () => {
    const csvUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/report.csv";
    server.use(
      http.get(csvUrl, () => {
        return HttpResponse.text("name,count\nkitten,2\npuppy,3", {
          headers: { "Content-Type": "text/csv" },
        });
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[报表](${csvUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-csv")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open csv preview for report.csv"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open csv preview for report.csv"),
    );

    await waitFor(() => {
      expect(screen.getByText("name")).toBeInTheDocument();
      expect(screen.getByText("count")).toBeInTheDocument();
      expect(screen.getByText("kitten")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
    });
  });

  it("renders text body links inline and supports collapse for platform file urls", async () => {
    const txtUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/readme.txt#summary";
    let requestedUrl = "";
    let requestedRange = "";
    server.use(
      http.get(
        "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/readme.txt",
        ({ request }) => {
          requestedUrl = request.url;
          requestedRange = request.headers.get("Range") ?? "";
          return HttpResponse.text("hello from text preview");
        },
      ),
    );

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[readme](${txtUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-text")).toBeInTheDocument();
      expect(screen.getByText("hello from text preview")).toBeInTheDocument();
    });
    expect(new URL(requestedUrl).searchParams.get("raw")).toBeNull();
    expect(requestedRange).toBe("bytes=0-65535");
    const download = screen.getByLabelText("Download readme.txt");
    expect(download).toHaveAttribute("type", "button");
    expect(download).not.toHaveAttribute("href");

    await userEvent.click(
      screen.getByLabelText("Collapse text preview for readme.txt"),
    );

    await waitFor(() => {
      expect(
        screen.queryByText("hello from text preview"),
      ).not.toBeInTheDocument();
    });
  });

  it.each([
    {
      filename: "config.xml",
      content: "<settings><enabled>true</enabled></settings>",
      expectedText: "settings",
    },
    {
      filename: "deploy.yaml",
      content: "enabled: true\nregion: us-east-1",
      expectedText: "region: us-east-1",
    },
    {
      filename: "table.tsv",
      content: "name\tvalue\nalpha\t1",
      expectedText: "alpha",
    },
  ])(
    "renders $filename body links as text previews for platform file urls",
    async ({ filename, content, expectedText }) => {
      const fileUrl = `https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/${filename}`;
      server.use(
        http.get(fileUrl, () => {
          return HttpResponse.text(content);
        }),
      );

      mockChatLifecycle({
        chatMessages: [
          {
            role: "assistant",
            content: `[file](${fileUrl})`,
            createdAt: "2026-03-10T00:00:00Z",
          },
        ],
      });

      detachedSetupPage({ context, path: "/chats/thread-test-1" });

      await waitFor(() => {
        const textPreview = screen.getByTestId("attachment-preview-text");
        expect(textPreview).toBeInTheDocument();
        expect(
          within(textPreview).getByText((content) => {
            return content.includes(expectedText);
          }),
        ).toBeInTheDocument();
      });
    },
  );

  it("renders non-inline platform file links as thumbnail preview blocks", async () => {
    const docUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/budget.xlsx";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[budget](${docUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const preview = screen.getByTestId("attachment-preview-file");
      expect(preview).toBeInTheDocument();
      expect(
        within(preview).getByTestId("attachment-preview-file-icon"),
      ).toBeInTheDocument();
      expect(within(preview).getByText("XLSX")).toBeInTheDocument();
      const download = screen.getByLabelText("Download budget.xlsx");
      expect(download).toHaveAttribute("type", "button");
      expect(download).not.toHaveAttribute("href");
    });
  });

  it("renders structured non-inline attached files as compact download chips", async () => {
    const fileUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/budget.xlsx";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Please review",
          createdAt: "2026-03-10T00:00:00Z",
          attachFiles: [
            {
              id: "file-budget",
              filename: "budget.xlsx",
              contentType:
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              size: 2048,
              url: fileUrl,
            },
          ],
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const preview = screen.getByLabelText("Download budget.xlsx");
      expect(
        within(preview).queryByTestId("attachment-preview-file-icon"),
      ).not.toBeInTheDocument();
      expect(
        within(preview).getByTestId("attachment-chip-file-icon"),
      ).toBeInTheDocument();
      expect(within(preview).getByText("XLSX")).toBeInTheDocument();
      expect(preview).toHaveAttribute("type", "button");
      expect(preview).not.toHaveAttribute("href");
    });
  });

  it("preserves assistant soft line breaks without forcing hard breaks", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "Here is some text that wraps\nacross multiple lines for readability.",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const assistant = document.querySelector(
        '[data-role="assistant"] .zero-chat-bubble-assistant',
      );
      expect(assistant?.textContent?.replace(/\s+/g, " ")).toContain(
        "Here is some text that wraps across multiple lines for readability.",
      );
      expect(assistant?.querySelector("br")).toBeNull();
    });
  });

  it("renders assistant inline and block math", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: "Inline $x^2$.\n\n$$\nx^2\n$$",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const assistant = document.querySelector(
        '[data-role="assistant"] .zero-chat-bubble-assistant',
      );
      expect(assistant?.querySelector(".katex")).toBeInTheDocument();
      expect(assistant?.querySelector(".katex-display")).toBeInTheDocument();
    });
  });

  it("keeps assistant math delimiters inside code fences as code", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: "Here is code:\n```text\n$x^2$\n```\nDone.",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const assistant = document.querySelector(
        '[data-role="assistant"] .zero-chat-bubble-assistant',
      );
      expect(assistant?.querySelector("code")?.textContent).toContain("$x^2$");
      expect(assistant?.querySelector(".katex")).toBeNull();
    });
  });

  it("does not render a single ordinary dollar amount as math", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: "The total is $5 today.",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const assistant = document.querySelector(
        '[data-role="assistant"] .zero-chat-bubble-assistant',
      );
      expect(assistant?.textContent).toContain("The total is $5 today.");
      expect(assistant?.querySelector(".katex")).toBeNull();
    });
  });

  it("keeps previewable markdown links inside assistant code fences as code", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "Here is the syntax:\n```markdown\n[PRD](https://example.com/prd.md)\n```\nDone.",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const assistant = document.querySelector(
        '[data-role="assistant"] .zero-chat-bubble-assistant',
      );
      expect(assistant?.textContent).toContain(
        "[PRD](https://example.com/prd.md)",
      );
    });
    expect(screen.queryByTestId("attachment-preview-markdown")).toBeNull();
    expect(
      screen.queryByLabelText("Open markdown preview for prd.md"),
    ).toBeNull();
  });
});

// CHAT-D-065: Video attachments render as poster buttons and open playback preview.
describe("zero chat thread page display - attachment video preview", () => {
  it("renders an mp4 attachment poster and opens an autoplaying preview", async () => {
    const videoUrl = "https://example.com/clip.mp4";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: clip.mp4](${videoUrl})\nDownload with: curl ${videoUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const previewButton = await waitFor(() => {
      return screen.getByLabelText("Preview clip.mp4");
    });
    const posterVideo = previewButton.querySelector("video");

    expect(
      within(previewButton).getByTestId("chat-video-preview-poster"),
    ).toBeInTheDocument();
    expect(posterVideo?.getAttribute("src")).toBe(`${videoUrl}#t=0.001`);
    expect(posterVideo?.hasAttribute("controls")).toBeFalsy();
    expect(
      screen.queryByLabelText("Video preview for clip.mp4"),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector(`img[src="${videoUrl}"]`),
    ).not.toBeInTheDocument();

    await userEvent.click(previewButton);

    const lightbox = await waitFor(() => {
      return screen.getByTestId("attachment-lightbox");
    });
    const video = within(lightbox).getByLabelText("Video preview for clip.mp4");

    expect(video).toHaveAttribute("src", videoUrl);
    expect(video).toHaveAttribute("controls");
    expect((video as HTMLVideoElement).autoplay).toBeTruthy();
    expect(within(lightbox).getByLabelText("Copy link")).toBeInTheDocument();
    expect(within(lightbox).getByLabelText("Download")).toBeInTheDocument();
  });
});

describe("zero chat thread page display - attachment html preview", () => {
  it("keeps html attachments as chips and opens preview on click", async () => {
    const htmlUrl = "https://example.com/report.html";
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>report preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: report.html](${htmlUrl})\nDownload with: curl ${htmlUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open html preview for report.html"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open html preview for report.html"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("report.html preview")).toBeInTheDocument();
    });
  });
});

describe("zero chat thread page display - attachment json preview", () => {
  it("keeps json attachments as chips and opens preview on click", async () => {
    const jsonUrl = "https://example.com/data.json";
    server.use(
      http.get(jsonUrl, () => {
        return HttpResponse.text('{"status":"ok","count":2}');
      }),
    );

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: data.json](${jsonUrl})\nDownload with: curl ${jsonUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open json preview for data.json"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open json preview for data.json"),
    );

    await waitFor(() => {
      expect(screen.getByText(/"status": "ok"/)).toBeInTheDocument();
      expect(screen.getByText(/"count": 2/)).toBeInTheDocument();
    });
  });
});

describe("zero chat thread page display - attachment pdf preview", () => {
  it("keeps pdf attachments as chips and opens preview on click", async () => {
    const pdfUrl = "https://example.com/document.pdf";
    server.use(
      http.get(pdfUrl, () => {
        return new HttpResponse("%PDF-1.4", {
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: document.pdf](${pdfUrl})\nDownload with: curl ${pdfUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open pdf preview for document.pdf"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open pdf preview for document.pdf"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("document.pdf preview")).toBeInTheDocument();
    });
  });
});

describe("zero chat thread page display - artifacts drawer", () => {
  it("opens a drawer with uploaded files grouped by run when enabled", async () => {
    const user = userEvent.setup();
    let artifactsRequests = 0;
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "See attached",
          runId: "run-artifacts-1",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      http.get("https://example.com/chart.png", () => {
        return new HttpResponse(new Blob(["img"], { type: "image/png" }), {
          headers: { "Content-Type": "image/png" },
        });
      }),
      http.get("https://example.com/data.csv", () => {
        return new HttpResponse("label,value\nalpha,1\n", {
          headers: { "Content-Type": "text/csv" },
        });
      }),
      http.get("https://example.com/deck.pptx", () => {
        return new HttpResponse(
          new Blob(["ppt"], {
            type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          }),
          {
            headers: {
              "Content-Type":
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            },
          },
        );
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        artifactsRequests += 1;
        return respond(200, {
          runs: [
            {
              runId: "run-artifacts-1",
              files: [
                {
                  id: "file-1",
                  filename: "chart.png",
                  contentType: "image/png",
                  size: 4096,
                  url: "https://example.com/chart.png",
                  createdAt: "2026-03-10T00:00:00Z",
                },
                {
                  id: "file-2",
                  filename: "data.csv",
                  contentType: "text/csv",
                  size: 2048,
                  url: "https://example.com/data.csv",
                  createdAt: "2026-03-10T00:00:00Z",
                },
                {
                  id: "file-3",
                  filename: "deck.pptx",
                  contentType:
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                  size: 3072,
                  url: "https://example.com/deck.pptx",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:artifact-download");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let downloadedFilename = "";
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadedFilename = this.download;
      });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const button = await waitFor(() => {
      return screen.getByLabelText("Open artifacts");
    });
    expect(artifactsRequests).toBe(0);
    click(button);

    await waitFor(() => {
      expect(screen.getByText("Artifacts")).toBeInTheDocument();
    });
    expect(artifactsRequests).toBeGreaterThan(0);
    const previewLink = screen.getByLabelText("Preview chart.png");
    expect(previewLink).toHaveAttribute(
      "href",
      "https://example.com/chart.png",
    );
    expect(
      document.querySelectorAll('img[src="https://example.com/chart.png"]')
        .length,
    ).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByLabelText("Download chart.png")).toHaveLength(1);
    await user.click(screen.getByLabelText("More artifact actions"));
    await user.click(screen.getByText("Download all"));
    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalledOnce();
      expect(anchorClickSpy).toHaveBeenCalledOnce();
    });
    expect(downloadedFilename).toBe("vm0-artifact-thread-test-1.zip");
    const zipBlob = createObjectURLSpy.mock.calls[0]?.[0];
    expect(zipBlob).toBeInstanceOf(Blob);
    expect((zipBlob as Blob).type).toBe("application/zip");
    const zipText = new TextDecoder().decode(
      await (zipBlob as Blob).arrayBuffer(),
    );
    expect(zipText).toContain("chart.png");
    expect(zipText).toContain("data.csv");
    expect(screen.getAllByText("chart.png").length).toBeGreaterThan(0);
    expect(screen.getByText("data.csv")).toBeInTheDocument();
    const deckButton = screen.getByLabelText("Select deck.pptx");
    expect(deckButton).toBeInTheDocument();
    expect(within(deckButton).getByText("PPTX")).toBeInTheDocument();

    await user.click(previewLink);

    const lightbox = await screen.findByTestId("attachment-lightbox");
    await user.click(within(lightbox).getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Artifacts")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Select data.csv"));
    await waitFor(() => {
      const table = screen.getByRole("table");
      expect(within(table).getByText("label")).toBeInTheDocument();
      expect(within(table).getByText("value")).toBeInTheDocument();
      expect(within(table).getByText("alpha")).toBeInTheDocument();
      expect(within(table).getByText("1")).toBeInTheDocument();
    });
  });

  it("opens artifacts from the mobile top bar icon", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Create a file",
          runId: "run-mobile-artifacts",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-mobile-artifacts",
              files: [
                {
                  id: "file-mobile",
                  filename: "mobile.zip",
                  contentType: "application/zip",
                  size: 512,
                  url: "https://example.com/mobile.zip",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Open mobile artifacts");
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Artifacts")).toBeInTheDocument();
      expect(screen.getAllByText("mobile.zip").length).toBeGreaterThan(0);
    });
    expect(screen.getByRole("dialog", { name: "Artifacts" })).toHaveClass(
      "max-w-[100vw]",
    );
  });

  it("renders markdown artifacts through the text loader instead of an iframe", async () => {
    const user = userEvent.setup();
    let requestedUrl = "";
    let requestedRange = "";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Create markdown",
          runId: "run-markdown-artifact",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      http.get("https://example.com/readme.md", ({ request }) => {
        requestedUrl = request.url;
        requestedRange = request.headers.get("Range") ?? "";
        return HttpResponse.text("# 发布说明\n\n这里是中文内容");
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-markdown-artifact",
              files: [
                {
                  id: "file-md",
                  filename: "readme.md",
                  contentType: "text/markdown",
                  size: 1024,
                  url: "https://example.com/readme.md",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Open artifacts");
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("发布说明")).toBeInTheDocument();
      expect(screen.getByText("这里是中文内容")).toBeInTheDocument();
    });
    expect(new URL(requestedUrl).searchParams.get("raw")).toBeNull();
    expect(requestedRange).toBe("bytes=0-65535");
    expect(
      document.querySelector('iframe[title="Preview readme.md"]'),
    ).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Open preview for readme.md"));
    const lightbox = await screen.findByTestId("attachment-lightbox");
    expect(within(lightbox).getByText("发布说明")).toBeInTheDocument();
  });

  it("renders xml artifacts through the text loader instead of an iframe", async () => {
    const user = userEvent.setup();
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Create XML",
          runId: "run-xml-artifact",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      http.get("https://example.com/config.xml", () => {
        return HttpResponse.text("<config><enabled>true</enabled></config>");
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-xml-artifact",
              files: [
                {
                  id: "file-xml",
                  filename: "config.xml",
                  contentType: "application/xml",
                  size: 512,
                  url: "https://example.com/config.xml",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Open artifacts");
      }),
    );

    await waitFor(() => {
      expect(screen.getByText(/<config>/)).toBeInTheDocument();
    });
    expect(
      document.querySelector('iframe[title="Preview config.xml"]'),
    ).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Open preview for config.xml"));
    const lightbox = await screen.findByTestId("attachment-lightbox");
    expect(within(lightbox).getByText(/<config>/)).toBeInTheDocument();
  });

  it("renders html artifacts as document iframe previews", async () => {
    const user = userEvent.setup();
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Create HTML",
          runId: "run-html-artifact",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      http.get("https://example.com/report.html", () => {
        return HttpResponse.html("<html><body>report preview</body></html>");
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-html-artifact",
              files: [
                {
                  id: "file-html",
                  filename: "report.html",
                  contentType: "text/html",
                  size: 1024,
                  url: "https://example.com/report.html",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Open artifacts");
      }),
    );

    await waitFor(() => {
      expect(
        document.querySelector('iframe[title="Preview report.html"]'),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Open preview for report.html"));
    const lightbox = await screen.findByTestId("attachment-lightbox");
    expect(within(lightbox).getByTitle("report.html preview")).toHaveAttribute(
      "src",
      "https://example.com/report.html",
    );
  });

  it("refreshes uploaded files from the artifacts Ably signal while the drawer is open", async () => {
    const threadId = "thread-test-1";
    let artifactsRequests = 0;
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Upload from a run",
          runId: "run-artifacts-ably",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        artifactsRequests += 1;
        return respond(200, {
          runs:
            artifactsRequests === 1
              ? []
              : [
                  {
                    runId: "run-artifacts-ably",
                    files: [
                      {
                        id: "file-ably",
                        filename: "artifact.zip",
                        contentType: "application/zip",
                        size: 8192,
                        url: "https://example.com/artifact.zip",
                        createdAt: "2026-03-10T00:00:00Z",
                      },
                    ],
                  },
                ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const button = await waitFor(() => {
      return screen.getByLabelText("Open artifacts");
    });
    click(button);

    await waitFor(() => {
      expect(
        screen.getByText("No uploaded files in this chat yet."),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        hasSubscription(`chatThreadArtifactsChanged:${threadId}`),
      ).toBeTruthy();
    });

    updateChatArtifacts(threadId);

    await waitFor(() => {
      expect(screen.getAllByText("artifact.zip").length).toBeGreaterThan(0);
    });
    expect(artifactsRequests).toBeGreaterThanOrEqual(2);
  });

  it("copies artifact links and syncs to Google Drive when connected", async () => {
    const user = userEvent.setup();
    const fileUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/chart.png";
    const publicFileUrl =
      "https://cdn.vm7.io/artifacts/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/chart.png";
    let artifactsRequests = 0;
    const syncBodies: unknown[] = [];
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "See attached",
          runId: "run-artifacts-actions",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    setMockConnectors([
      {
        id: "00000000-0000-4000-8000-000000000000",
        type: "google-drive",
        authMethod: "oauth",
        externalId: "drive-user",
        externalUsername: "Drive User",
        externalEmail: "drive@example.com",
        oauthScopes: ["https://www.googleapis.com/auth/drive"],
        needsReconnect: false,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    server.use(
      http.get(fileUrl, () => {
        return new HttpResponse(new Blob(["img"], { type: "image/png" }), {
          headers: { "Content-Type": "image/png" },
        });
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        artifactsRequests += 1;
        return respond(200, {
          runs: [
            {
              runId: "run-artifacts-actions",
              files: [
                {
                  id: "file-1",
                  filename: "chart.png",
                  contentType: "image/png",
                  size: 4096,
                  url: fileUrl,
                  createdAt: "2026-03-10T00:00:00Z",
                  googleDriveSync:
                    artifactsRequests > 1
                      ? {
                          status: "synced",
                          id: "drive-file-id",
                          name: "chart.png",
                          webViewLink:
                            "https://drive.google.com/file/d/drive-file-id/view",
                        }
                      : { status: "not_synced" },
                },
                {
                  id: "file-2",
                  filename: "data.csv",
                  contentType: "text/csv",
                  size: 2048,
                  url: "https://example.com/data.csv",
                  createdAt: "2026-03-10T00:00:00Z",
                  googleDriveSync: { status: "not_synced" },
                },
              ],
            },
          ],
        });
      }),
      mockApi(
        chatThreadArtifactsContract.syncGoogleDrive,
        ({ body, respond }) => {
          syncBodies.push(body);
          return respond(200, {
            id: "drive-file-id",
            name: "chart.png",
            webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
          });
        },
      ),
    );
    const writeTextSpy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const button = await waitFor(() => {
      return screen.getByLabelText("Open artifacts");
    });
    click(button);

    await waitFor(() => {
      expect(
        screen.getByLabelText("Copy link for chart.png"),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Copy link for chart.png"));
    expect(writeTextSpy).toHaveBeenCalledWith(publicFileUrl);

    await user.click(screen.getByLabelText("Sync chart.png to Google Drive"));

    await waitFor(() => {
      expect(syncBodies).toStrictEqual([
        {
          runId: "run-artifacts-actions",
          fileId: "file-1",
        },
      ]);
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText("chart.png is synced to Google Drive"),
      ).toHaveAttribute("aria-disabled", "true");
    });

    await user.click(screen.getByLabelText("More artifact actions"));
    await user.click(screen.getByText("Sync all to Google Drive"));

    await waitFor(() => {
      expect(syncBodies).toStrictEqual([
        {
          runId: "run-artifacts-actions",
          fileId: "file-1",
        },
        {
          runId: "run-artifacts-actions",
          fileId: "file-2",
        },
      ]);
    });
  });

  it("syncs bulk Google Drive artifacts sequentially", async () => {
    const user = userEvent.setup();
    const syncBodies: unknown[] = [];
    let firstSyncFinished = false;
    let secondSyncStartedAfterFirst = false;
    let releaseFirstSync: () => void = () => {
      throw new Error("First sync has not started");
    };

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "See attached",
          runId: "run-artifacts-sequential-sync",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    setMockConnectors([
      {
        id: "00000000-0000-4000-8000-000000000000",
        type: "google-drive",
        authMethod: "oauth",
        externalId: "drive-user",
        externalUsername: "Drive User",
        externalEmail: "drive@example.com",
        oauthScopes: ["https://www.googleapis.com/auth/drive"],
        needsReconnect: false,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    server.use(
      http.get("https://example.com/first.csv", () => {
        return new HttpResponse("label,value\nfirst,1\n", {
          headers: { "Content-Type": "text/csv" },
        });
      }),
      http.get("https://example.com/second.csv", () => {
        return new HttpResponse("label,value\nsecond,2\n", {
          headers: { "Content-Type": "text/csv" },
        });
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-artifacts-sequential-sync",
              files: [
                {
                  id: "file-1",
                  filename: "first.csv",
                  contentType: "text/csv",
                  size: 1024,
                  url: "https://example.com/first.csv",
                  createdAt: "2026-03-10T00:00:00Z",
                  googleDriveSync: { status: "not_synced" },
                },
                {
                  id: "file-2",
                  filename: "second.csv",
                  contentType: "text/csv",
                  size: 2048,
                  url: "https://example.com/second.csv",
                  createdAt: "2026-03-10T00:00:00Z",
                  googleDriveSync: { status: "not_synced" },
                },
              ],
            },
          ],
        });
      }),
      mockApi(
        chatThreadArtifactsContract.syncGoogleDrive,
        ({ body, respond, deferred }) => {
          syncBodies.push(body);
          if (body.fileId === "file-1") {
            const gate = deferred<void>();
            releaseFirstSync = () => {
              firstSyncFinished = true;
              gate.resolve();
            };
            return gate.promise.then(() => {
              return respond(200, {
                id: `drive-${body.fileId}`,
                name: `${body.fileId}.csv`,
                webViewLink: `https://drive.google.com/file/d/${body.fileId}/view`,
              });
            });
          }
          if (body.fileId === "file-2") {
            secondSyncStartedAfterFirst = firstSyncFinished;
          }
          return respond(200, {
            id: `drive-${body.fileId}`,
            name: `${body.fileId}.csv`,
            webViewLink: `https://drive.google.com/file/d/${body.fileId}/view`,
          });
        },
      ),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const button = await waitFor(() => {
      return screen.getByLabelText("Open artifacts");
    });
    click(button);

    await waitFor(() => {
      expect(screen.getAllByText("first.csv").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByLabelText("More artifact actions"));
    await user.click(screen.getByText("Sync all to Google Drive"));

    await waitFor(() => {
      expect(syncBodies).toStrictEqual([
        {
          runId: "run-artifacts-sequential-sync",
          fileId: "file-1",
        },
      ]);
    });

    releaseFirstSync();

    await waitFor(() => {
      expect(syncBodies).toStrictEqual([
        {
          runId: "run-artifacts-sequential-sync",
          fileId: "file-1",
        },
        {
          runId: "run-artifacts-sequential-sync",
          fileId: "file-2",
        },
      ]);
    });
    expect(secondSyncStartedAfterFirst).toBeTruthy();
  });

  it("opens Google Drive OAuth in a new tab and syncs after the connector event", async () => {
    const user = userEvent.setup();
    const fileUrl = "https://example.com/disconnected-chart.png";
    let authorizeCalled = false;
    let syncSawAuthorize = false;
    let syncBody: unknown;
    mockConnectorOauthStart();
    const mockWindow = createMockAuthWindow();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(mockWindow as unknown as Window);

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "See attached",
          runId: "run-artifacts-disconnected-actions",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    setMockConnectors([]);
    server.use(
      http.get(fileUrl, () => {
        return new HttpResponse(new Blob(["img"], { type: "image/png" }), {
          headers: { "Content-Type": "image/png" },
        });
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-artifacts-disconnected-actions",
              files: [
                {
                  id: "file-disconnected",
                  filename: "disconnected-chart.png",
                  contentType: "image/png",
                  size: 4096,
                  url: fileUrl,
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
      mockApi(
        chatThreadArtifactsContract.syncGoogleDrive,
        ({ body, respond }) => {
          syncSawAuthorize = authorizeCalled;
          syncBody = body;
          return respond(200, {
            id: "drive-file-id",
            name: "disconnected-chart.png",
            webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
          });
        },
      ),
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledTypes: [] });
      }),
      mockApi(zeroUserConnectorsContract.update, ({ body, respond }) => {
        authorizeCalled = body.enabledTypes.includes("google-drive");
        return respond(200, { enabledTypes: body.enabledTypes });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const button = await waitFor(() => {
      return screen.getByLabelText("Open artifacts");
    });
    click(button);

    const syncButton = await waitFor(() => {
      return screen.getByLabelText(
        "Sync disconnected-chart.png to Google Drive",
      );
    });

    await user.click(syncButton);
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        "about:blank",
        "_blank",
        "width=600,height=700",
      );
      expect(mockWindow.location.href).toBe(
        "https://oauth.test/google-drive/authorize",
      );
      expect(hasSubscription("connector:changed")).toBeTruthy();
    });
    expect(syncBody).toBeUndefined();

    setMockConnectors([
      {
        id: "00000000-0000-4000-8000-000000000000",
        type: "google-drive",
        authMethod: "oauth",
        externalId: "drive-user",
        externalUsername: "Drive User",
        externalEmail: "drive@example.com",
        oauthScopes: ["https://www.googleapis.com/auth/drive"],
        needsReconnect: false,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    triggerAblyEvent("connector:changed");

    await waitFor(() => {
      expect(syncBody).toStrictEqual({
        runId: "run-artifacts-disconnected-actions",
        fileId: "file-disconnected",
      });
      expect(syncSawAuthorize).toBeTruthy();
    });
  });
});

describe("zero chat thread page display - GitHub PR tracking", () => {
  function setConnectedGithubConnector() {
    setMockConnectors([
      {
        id: "00000000-0000-4000-8000-000000000010",
        type: "github",
        authMethod: "oauth",
        externalId: "github-user",
        externalUsername: "octocat",
        externalEmail: "octocat@example.com",
        oauthScopes: ["repo", "workflow"],
        needsReconnect: false,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
  }

  it("opens a docked panel with tracked GitHub PR action status when enabled and authorized", async () => {
    const user = userEvent.setup();
    let prsRequests = 0;
    const sentPrompts: string[] = [];
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "Created https://github.com/vm0-ai/vm0/pull/15070 and waiting on CI.",
          runId: "run-github-pr-tracking",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    setConnectedGithubConnector();
    setMockGithubIntegration(
      createDefaultMockGithubIntegration({
        labelListeners: [
          {
            id: "a0000000-0000-4000-a000-000000000010",
            labelName: "pr-review-merge",
            triggerMode: "created_by_me",
            prompt: "review",
            enabled: true,
            canManage: true,
            agent: {
              id: "c0000000-0000-4000-a000-000000000001",
              name: "zero",
            },
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          },
        ],
      }),
    );
    server.use(
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledTypes: ["github"] });
      }),
      mockApi(chatMessagesContract.send, ({ body, respond }) => {
        if ("prompt" in body && body.prompt) {
          sentPrompts.push(body.prompt);
        }
        return respond(201, {
          runId: null,
          threadId: "thread-test-1",
        });
      }),
      mockApi(chatThreadGithubPrsContract.list, ({ params, respond }) => {
        prsRequests += 1;
        expect(params.threadId).toBe("thread-test-1");
        return respond(200, {
          prs: [
            {
              repo: "vm0-ai/vm0",
              number: 15_070,
              title: "Add GitHub PR tracking",
              url: "https://github.com/vm0-ai/vm0/pull/15070",
              state: "open",
              headSha: "abc123",
              mergeStatus: "ready",
              rollup: "success",
              checks: [
                {
                  name: "CI",
                  status: "completed",
                  conclusion: "success",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/1",
                  startedAt: "2026-06-02T00:00:00Z",
                  completedAt: "2026-06-02T00:01:00Z",
                },
              ],
            },
            {
              repo: "vm0-ai/vm0",
              number: 15_071,
              title: "Fix merge conflict",
              url: "https://github.com/vm0-ai/vm0/pull/15071",
              state: "open",
              headSha: "def456",
              mergeStatus: "conflicts",
              rollup: "failure",
              checks: [
                {
                  name: "Build",
                  status: "completed",
                  conclusion: "failure",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/2",
                  startedAt: "2026-06-02T00:00:00Z",
                  completedAt: "2026-06-02T00:01:00Z",
                },
                {
                  name: "Deploy",
                  status: "in_progress",
                  conclusion: null,
                  url: "https://github.com/vm0-ai/vm0/actions/runs/3",
                  startedAt: "2026-06-02T00:02:00Z",
                  completedAt: null,
                },
                {
                  name: "Lint",
                  status: "completed",
                  conclusion: "success",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/4",
                  startedAt: "2026-06-02T00:03:00Z",
                  completedAt: "2026-06-02T00:04:00Z",
                },
                {
                  name: "Test",
                  status: "completed",
                  conclusion: "success",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/5",
                  startedAt: "2026-06-02T00:04:00Z",
                  completedAt: "2026-06-02T00:05:00Z",
                },
                {
                  name: "Package",
                  status: "completed",
                  conclusion: "success",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/6",
                  startedAt: "2026-06-02T00:05:00Z",
                  completedAt: "2026-06-02T00:06:00Z",
                },
                {
                  name: "Security",
                  status: "completed",
                  conclusion: "success",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/7",
                  startedAt: "2026-06-02T00:06:00Z",
                  completedAt: "2026-06-02T00:07:00Z",
                },
                {
                  name: "E2E",
                  status: "completed",
                  conclusion: "success",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/8",
                  startedAt: "2026-06-02T00:07:00Z",
                  completedAt: "2026-06-02T00:08:00Z",
                },
              ],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ChatGithubPrTracking]: true },
    });

    const button = await waitFor(() => {
      return screen.getByLabelText("Open GitHub PR tracking");
    });
    expect(prsRequests).toBe(0);
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByText("GitHub PRs")).toBeInTheDocument();
    });
    expect(screen.getByText("vm0-ai/vm0 #15070")).toBeInTheDocument();
    expect(screen.getByText("Add GitHub PR tracking")).toBeInTheDocument();
    expect(screen.getByText("Ready to merge")).toBeInTheDocument();
    expect(screen.getByText("Fix merge conflict")).toBeInTheDocument();
    expect(screen.getByText("Conflicts")).toBeInTheDocument();
    expect(screen.queryByText("Passing")).not.toBeInTheDocument();
    expect(
      screen
        .getByText("Fix merge conflict")
        .compareDocumentPosition(screen.getByText("Add GitHub PR tracking")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("CI")).toBeInTheDocument();
    expect(screen.getAllByText("Success").length).toBeGreaterThan(0);
    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.getByText("Deploy")).toBeInTheDocument();
    expect(screen.getByText("E2E")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(
      screen
        .getByText("Build")
        .compareDocumentPosition(screen.getByText("Deploy")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(queryRoleByText("link", "Open PR")).toBeUndefined();
    expect(queryRoleByText("link", "CI")).toBeUndefined();
    const ciRow = screen.getByText("CI").closest("details");
    expect(ciRow).toBeInstanceOf(HTMLDetailsElement);
    if (!(ciRow instanceof HTMLDetailsElement)) {
      throw new Error("CI check row was not rendered");
    }
    expect(ciRow.open).toBeFalsy();
    await user.click(screen.getByText("CI"));
    expect(ciRow.open).toBeTruthy();
    expect(within(ciRow).getByText("Started")).toBeVisible();
    expect(within(ciRow).getByText("Completed")).toBeVisible();
    const actionLink = queryAllByRoleFast("link", ciRow).find((link) => {
      return link.textContent?.trim() === "Open action";
    });
    expect(actionLink).toBeDefined();
    expect(actionLink).toHaveAttribute(
      "href",
      "https://github.com/vm0-ai/vm0/actions/runs/1",
    );

    await user.click(getRoleByText("button", "Fix conflict"));
    expect(sentPrompts).toContain("fix pr 15071 conflict & push");

    const addLabelButton = queryRoleByAriaLabel(
      "button",
      "Add label to PR 15070",
    );
    expect(addLabelButton).toBeDefined();
    await user.click(addLabelButton!);
    await user.click(getRoleByText("menuitem", "pr-review-merge"));
    expect(sentPrompts).toContain('add label "pr-review-merge" to pr 15070');
    expect(prsRequests).toBeGreaterThan(0);
  });

  it("hides add label when no GitHub integration labels are configured", async () => {
    const user = userEvent.setup();
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "Created https://github.com/vm0-ai/vm0/pull/15070 and waiting on CI.",
          runId: "run-github-pr-tracking-no-labels",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    setConnectedGithubConnector();
    setMockGithubIntegration(
      createDefaultMockGithubIntegration({ labelListeners: [] }),
    );
    server.use(
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledTypes: ["github"] });
      }),
      mockApi(chatThreadGithubPrsContract.list, ({ respond }) => {
        return respond(200, {
          prs: [
            {
              repo: "vm0-ai/vm0",
              number: 15_070,
              title: "Add GitHub PR tracking",
              url: "https://github.com/vm0-ai/vm0/pull/15070",
              state: "open",
              headSha: "abc123",
              mergeStatus: "ready",
              rollup: "success",
              checks: [],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ChatGithubPrTracking]: true },
    });

    await user.click(await screen.findByLabelText("Open GitHub PR tracking"));

    await waitFor(() => {
      expect(screen.getByText("Add GitHub PR tracking")).toBeInTheDocument();
    });
    expect(screen.queryByText("Add label")).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.getAttribute("aria-label")?.startsWith("Add label to PR");
      }),
    ).toBeFalsy();
  });

  it("hides the GitHub PR tracking button when the agent is not authorized", async () => {
    let authorizationRequests = 0;
    mockChatLifecycle();
    setConnectedGithubConnector();
    server.use(
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        authorizationRequests += 1;
        return respond(200, { enabledTypes: [] });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ChatGithubPrTracking]: true },
    });

    await waitFor(() => {
      expect(authorizationRequests).toBeGreaterThan(0);
    });
    expect(
      screen.queryByLabelText("Open GitHub PR tracking"),
    ).not.toBeInTheDocument();
  });
});

// CHAT-D-043: Message status indicators render in ChatMessageRow
describe("zero chat thread page display - message status indicators", () => {
  it("displays a Stop button status indicator when a run is active", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Hello",
          runId: "run-1",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-1",
          status: "running",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });
});

describe("zero chat thread page display - manual history button", () => {
  it("shows load history by default when history exists", async () => {
    mockChatLifecycle({
      historyMessages: [
        {
          role: "user",
          content: "Older message",
          createdAt: "2026-03-09T23:59:59Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });
    expect(screen.getByText("Load history")).toBeInTheDocument();
  });

  it("shows load history when the feature switch is on and history exists", async () => {
    mockChatLifecycle({
      historyMessages: [
        {
          role: "user",
          content: "Older message",
          createdAt: "2026-03-09T23:59:59Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await waitFor(() => {
      expect(screen.getByText("Load history")).toBeInTheDocument();
    });
  });
});
