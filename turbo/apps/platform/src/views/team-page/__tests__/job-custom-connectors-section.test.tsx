import { describe, expect, it, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  setMockCustomConnectors,
  resetMockCustomConnectors,
} from "../../../mocks/handlers/api-custom-connectors.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  FeatureSwitchKey,
  type CustomConnectorResponse,
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/core";

const context = testContext();
const user = userEvent.setup();

const CC_1 = "00000001-0000-4000-a000-000000000001";
const AGENT_ID = "e0000000-0000-4000-a000-000000000010";

function makeConnector(
  overrides: Partial<CustomConnectorResponse> & { id: string },
): CustomConnectorResponse {
  return {
    slug: "acme-api",
    displayName: "Acme API",
    prefixes: ["https://api.acme.com/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
    hasSecret: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockAgentDetailAPIs() {
  setMockTeam([
    {
      id: AGENT_ID,
      displayName: "My Agent",
      description: "A helpful agent",
      sound: null,
      avatarUrl: null,
      headVersionId: "v2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: AGENT_ID,
        ownerId: "test-user-123",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [],
        modelProviderId: null,
        selectedModel: null,
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
  );
}

async function openAgentDetail() {
  detachedSetupPage({
    context,
    path: `/agents/${AGENT_ID}`,
    featureSwitches: { [FeatureSwitchKey.OrgCustomConnectors]: true },
  });

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "My Agent" }),
    ).toBeInTheDocument();
  });
}

describe("jobCustomConnectorsSection", () => {
  beforeEach(() => {
    resetMockCustomConnectors();
  });

  it("does not render when feature flag is off", async () => {
    mockAgentDetailAPIs();
    setMockCustomConnectors([makeConnector({ id: CC_1, displayName: "Acme" })]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}`,
      featureSwitches: { [FeatureSwitchKey.OrgCustomConnectors]: false },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });

    expect(screen.queryByText("Acme")).not.toBeInTheDocument();
  });

  it("does not render when no custom connectors exist", async () => {
    mockAgentDetailAPIs();
    setMockCustomConnectors([]);

    await openAgentDetail();

    expect(
      screen.queryByText(/Custom connectors registered by your org/),
    ).not.toBeInTheDocument();
  });

  it("renders connector rows with toggle switches", async () => {
    mockAgentDetailAPIs();
    setMockCustomConnectors([
      makeConnector({
        id: CC_1,
        displayName: "Stripe API",
        prefixes: ["https://api.stripe.com/"],
        hasSecret: true,
      }),
    ]);

    await openAgentDetail();

    await waitFor(() => {
      expect(screen.getByText("Stripe API")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("switch", {
        name: /Authorize Stripe API for this agent/i,
      }),
    ).toBeInTheDocument();
  });

  it("shows no credential set indicator for connectors without secret", async () => {
    mockAgentDetailAPIs();
    setMockCustomConnectors([
      makeConnector({
        id: CC_1,
        displayName: "No Key API",
        hasSecret: false,
      }),
    ]);

    await openAgentDetail();

    await waitFor(() => {
      expect(screen.getAllByText(/no credential set/i).length).toBeGreaterThan(
        0,
      );
    });
  });

  it("toggles connector on and persists via API", async () => {
    mockAgentDetailAPIs();
    setMockCustomConnectors([
      makeConnector({
        id: CC_1,
        displayName: "Acme API",
        hasSecret: true,
      }),
    ]);

    await openAgentDetail();

    const toggle = await screen.findByRole("switch", {
      name: /Authorize Acme API for this agent/i,
    });

    expect(toggle).toBeInTheDocument();

    await user.click(toggle);

    await waitFor(() => {
      expect(screen.getByText("Custom connectors saved")).toBeInTheDocument();
    });
  });
});
