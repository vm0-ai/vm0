import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
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

  it("writes a current-user grant from the confirm action", async () => {
    mockAgent();
    setMockUserPermissionGrants([]);

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
  });
});
