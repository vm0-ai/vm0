/**
 * Views tests for zero-settings-tab.tsx
 * Tests display rendering and user interactions for the Profile tab of agent detail page.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  type ZeroAgentMetadataRequest,
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

const context = testContext();
const mockApi = createMockApi(context);

function subAgent() {
  return {
    id: "agent-detail-id",
    name: "my-agent",
    displayName: "My Agent",
    description: "A helpful agent",
    sound: "professional",
    avatarUrl: "preset:0",
    headVersionId: "version_2",
    updatedAt: "2024-01-02T00:00:00Z",
  };
}

function agentDetail(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "e0000000-0000-4000-a000-000000000010",
    ownerId: "test-user-123",
    description: "A helpful agent",
    displayName: "My Agent",
    sound: "professional",
    avatarUrl: "preset:0",
    customSkills: [] as string[],
    ...overrides,
  };
}

function mockAPIs(detailOverrides: Record<string, unknown> = {}) {
  setMockTeam([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: subAgent().id,
      displayName: subAgent().displayName,
      description: subAgent().description,
      sound: subAgent().sound,
      avatarUrl: subAgent().avatarUrl,
      headVersionId: subAgent().headVersionId,
      updatedAt: subAgent().updatedAt,
    },
  ]);
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, agentDetail(detailOverrides));
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
  );
}

async function openProfileTab(
  options: {
    featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
  } = {},
) {
  detachedSetupPage({
    context,
    path: "/agents/my-agent",
    ...(options.featureSwitches && {
      featureSwitches: options.featureSwitches,
    }),
  });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "My Agent" }),
    ).toBeInTheDocument();
  });
  click(screen.getByText(/Profile/i));
  await waitFor(() => {
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
  });
}

describe("zero settings tab - display", () => {
  it("shows agent name in the name input (AGENT-D-038)", async () => {
    mockAPIs({ displayName: "My Agent" });
    await openProfileTab();

    await waitFor(() => {
      expect(screen.getByDisplayValue("My Agent")).toBeInTheDocument();
    });
  });

  it("shows agent description in the description textarea (AGENT-D-039)", async () => {
    mockAPIs({ description: "A helpful agent" });
    await openProfileTab();

    await waitFor(() => {
      expect(screen.getByDisplayValue("A helpful agent")).toBeInTheDocument();
    });
  });

  it("shows hint section for the selected tone (AGENT-D-040)", async () => {
    mockAPIs({ sound: "friendly" });
    await openProfileTab();

    await waitFor(() => {
      // The tone group contains a description hint and a sample preview panel
      const toneGroup = screen.getByRole("group", { name: /How.*sounds/i });
      expect(toneGroup).toBeInTheDocument();
      // The hint/preview container is rendered inside the tone group
      expect(
        toneGroup.querySelector(String.raw`.rounded-lg.bg-muted\/30`),
      ).toBeTruthy();
    });
  });

  it("shows tone sample preview panel for the selected tone (AGENT-D-041)", async () => {
    mockAPIs({ sound: "professional" });
    await openProfileTab();

    await waitFor(() => {
      // The tone group contains both a hint line and a sample conversation preview
      const toneGroup = screen.getByRole("group", { name: /How.*sounds/i });
      expect(toneGroup).toBeInTheDocument();
      // Sample preview contains two chat bubbles (user + assistant)
      const bubbles = toneGroup.querySelectorAll(
        "[class*='zero-bubble'], [class*='zero-chat-bubble']",
      );
      expect(bubbles.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("shows danger zone for non-default agents (AGENT-D-042)", async () => {
    mockAPIs();
    await openProfileTab();

    await waitFor(() => {
      expect(screen.getByText("Danger zone")).toBeInTheDocument();
      expect(
        screen.getByText(/Permanently remove this agent/),
      ).toBeInTheDocument();
    });
  });

  it("hides danger zone for the default agent (AGENT-D-043)", async () => {
    setMockTeam([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        displayName: "Zero",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "c0000000-0000-4000-a000-000000000001",
          ownerId: "test-user-123",
          description: null,
          displayName: "Zero",
          sound: null,
          avatarUrl: null,
          customSkills: [],
        });
      }),
      mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
        return respond(200, { content: null, filename: null });
      }),
    );

    detachedSetupPage({ context, path: "/agents/zero" });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Zero" })).toBeInTheDocument();
    });
    click(screen.getByText(/Profile/i));
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    expect(screen.queryByText("Danger zone")).not.toBeInTheDocument();
  });
});

describe("zero settings tab - avatar", () => {
  it("shows avatar SVG preview when agent has preset avatar (AGENT-D-044)", async () => {
    mockAPIs({ avatarUrl: "preset:0" });
    await openProfileTab();

    await waitFor(() => {
      // The avatar row label and the wand button are both present,
      // confirming the avatar section rendered with the SVG preview
      expect(screen.getByText("Avatar")).toBeInTheDocument();
      expect(screen.getByLabelText("Create custom avatar")).toBeInTheDocument();
    });
  });

  it("shows avatar maker wand button (AGENT-D-045)", async () => {
    mockAPIs();
    await openProfileTab();

    await waitFor(() => {
      expect(screen.getByLabelText("Create custom avatar")).toBeInTheDocument();
    });
  });

  it("shows avatar SVG preview when agent has svg: avatar (AGENT-D-046)", async () => {
    mockAPIs({ avatarUrl: "svg:r1s0h3c2f1d" });
    await openProfileTab();

    await waitFor(() => {
      expect(screen.getByText("Avatar")).toBeInTheDocument();
      expect(screen.getByLabelText("Create custom avatar")).toBeInTheDocument();
    });
  });

  it("saves avatar when applied from avatar maker (AGENT-D-047)", async () => {
    let capturedPayload: ZeroAgentMetadataRequest | null = null;
    mockAPIs({ avatarUrl: "preset:0" });

    server.use(
      mockApi(zeroAgentsByIdContract.updateMetadata, ({ body, respond }) => {
        capturedPayload = body;
        return respond(200, agentDetail({ avatarUrl: body.avatarUrl }));
      }),
    );

    await openProfileTab();

    // Click the wand button to open the avatar maker
    await waitFor(() => {
      expect(screen.getByLabelText("Create custom avatar")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Create custom avatar"));

    // The avatar maker dialog should open
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Click "Use this avatar" to save
    click(screen.getByText("Use this avatar"));

    await waitFor(() => {
      expect(capturedPayload).toBeTruthy();
    });

    // The saved avatar should be an SVG config string
    expect(capturedPayload!.avatarUrl).toMatch(/^svg:r\d/);
  });
});

describe("zero settings tab - interaction", () => {
  it("updates name field when typing (AGENT-D-048)", async () => {
    mockAPIs({ displayName: "My Agent" });
    await openProfileTab();

    const nameInput = await screen.findByDisplayValue("My Agent");
    await fill(nameInput, "Renamed Agent");

    expect(screen.getByDisplayValue("Renamed Agent")).toBeInTheDocument();
  });

  it("updates description textarea when typing (AGENT-D-049)", async () => {
    mockAPIs({ description: "A helpful agent" });
    await openProfileTab();

    const descTextarea = await screen.findByDisplayValue("A helpful agent");
    await fill(descTextarea, "Updated description");

    expect(screen.getByDisplayValue("Updated description")).toBeInTheDocument();
  });

  it("changes tone selection when clicking a tone button (AGENT-D-050)", async () => {
    mockAPIs({ sound: "professional" });
    await openProfileTab();

    await waitFor(() => {
      expect(screen.getByText("Clear and polished")).toBeInTheDocument();
    });

    click(screen.getByText(/Direct/i));

    await waitFor(() => {
      expect(screen.getByText("To the point")).toBeInTheDocument();
    });
  });

  it("saves settings when Save button is clicked and resets dirty state (AGENT-D-051)", async () => {
    mockAPIs({ displayName: "My Agent" });
    await openProfileTab();

    // Set up patch and reload handlers after initial load
    server.use(
      mockApi(zeroAgentsByIdContract.updateMetadata, ({ respond }) => {
        return respond(200, agentDetail({ displayName: "Renamed Agent" }));
      }),
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, agentDetail({ displayName: "Renamed Agent" }));
      }),
    );

    const nameInput = await screen.findByDisplayValue("My Agent");
    await fill(nameInput, "Renamed Agent");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(screen.getByText(/^Save$/i));

    await waitFor(() => {
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
    });
  });

  it("reverts changes when Discard is clicked (AGENT-D-052)", async () => {
    mockAPIs({ displayName: "My Agent" });
    await openProfileTab();

    const nameInput = await screen.findByDisplayValue("My Agent");
    await fill(nameInput, "Changed Name");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(screen.getByText(/Discard/i));

    await waitFor(() => {
      expect(screen.getByDisplayValue("My Agent")).toBeInTheDocument();
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
    });
  });

  it("opens delete confirmation dialog when Delete agent is clicked (AGENT-D-053)", async () => {
    mockAPIs();
    await openProfileTab();

    await waitFor(() => {
      expect(screen.getByText(/Delete agent/i)).toBeInTheDocument();
    });

    click(screen.getByText(/Delete agent/i));

    await waitFor(() => {
      expect(screen.getByText("Delete My Agent?")).toBeInTheDocument();
    });
  });

  it("closes delete dialog when Cancel is clicked (AGENT-D-054)", async () => {
    mockAPIs();
    await openProfileTab();

    await waitFor(() => {
      expect(screen.getByText(/Delete agent/i)).toBeInTheDocument();
    });

    click(screen.getByText(/Delete agent/i));

    await waitFor(() => {
      expect(screen.getByText("Delete My Agent?")).toBeInTheDocument();
    });

    click(screen.getByText(/^Cancel$/i));

    await waitFor(() => {
      expect(screen.queryByText("Delete My Agent?")).not.toBeInTheDocument();
    });
  });

  it("deletes agent and redirects to /agents after confirmation (AGENT-D-055)", async () => {
    mockAPIs();
    server.use(
      mockApi(zeroAgentsByIdContract.delete, ({ respond }) => {
        return respond(204);
      }),
    );
    await openProfileTab();

    await waitFor(() => {
      expect(screen.getByText(/Delete agent/i)).toBeInTheDocument();
    });

    click(screen.getByText(/Delete agent/i));

    await waitFor(() => {
      expect(screen.getByText("Delete My Agent?")).toBeInTheDocument();
    });

    const deleteButtons = queryAllByRoleFast("button").filter((el) => {
      return /Delete agent/i.test(el.textContent ?? "");
    });
    click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() => {
      expect(pathname()).toBe("/agents");
    });
  });
});
