import { screen, waitFor } from "@testing-library/react";
import {
  artifactsContract,
  type ArtifactItem,
  type ArtifactsListQuery,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const ZERO_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const SOURCE_THREAD_ID = "b0000000-0000-4000-a000-000000000001";

function createAgent(id: string, displayName: string | null): TeamComposeItem {
  return {
    id,
    ownerId: "test-user-123",
    displayName,
    description: null,
    sound: null,
    avatarUrl: null,
    visibility: "public",
    headVersionId: "version_1",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function setupTeam(): void {
  context.mocks.data.team([
    createAgent(ZERO_AGENT_ID, "Zero"),
    createAgent(RESEARCH_AGENT_ID, "Research Agent"),
  ]);
}

function createArtifact(overrides: Partial<ArtifactItem> = {}): ArtifactItem {
  return {
    artifactItemId: "run-1:file-1",
    threadId: SOURCE_THREAD_ID,
    runId: "run-1",
    fileId: "file-1",
    agentId: ZERO_AGENT_ID,
    agentName: "Zero",
    agentAvatarUrl: null,
    threadTitle: "Launch plan",
    filename: "launch-plan.html",
    contentType: "text/html",
    url: "https://artifacts.example.com/launch-plan.html",
    createdAt: "2026-01-01T00:00:00Z",
    artifactKind: "hosted-site",
    googleDriveSync: {
      status: "synced",
      id: "drive-1",
      name: "Launch plan",
      webViewLink: null,
    },
    ...overrides,
  };
}

function mockArtifacts(artifacts: readonly ArtifactItem[]): void {
  context.mocks.api(artifactsContract.list, ({ respond }) => {
    return respond(200, { artifacts: [...artifacts], nextCursor: null });
  });
}

function queryLinkByText(text: string): HTMLElement | undefined {
  return queryAllByRoleFast("link").find((link) => {
    return link.textContent?.replace(/\s+/g, " ").trim() === text;
  });
}

function linkByText(text: string): HTMLElement {
  const link = queryLinkByText(text);
  if (!link) {
    throw new Error(`${text} link not found`);
  }
  return link;
}

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

describe("artifacts page", () => {
  it("hides the entry and redirects when the feature switch is disabled", async () => {
    setupTeam();
    let requested = false;
    context.mocks.api(artifactsContract.list, ({ respond }) => {
      requested = true;
      return respond(200, { artifacts: [], nextCursor: null });
    });

    detachedSetupPage({
      context,
      path: "/artifacts",
      featureSwitches: {
        [FeatureSwitchKey.Artifacts]: false,
      },
    });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${ZERO_AGENT_ID}/chat`);
    });
    expect(requested).toBeFalsy();
    expect(queryLinkByText("Artifacts")).toBeUndefined();
  });

  it("shows the Manage entry and renders artifact metadata when enabled", async () => {
    setupTeam();
    mockArtifacts([createArtifact()]);

    detachedSetupPage({
      context,
      path: "/artifacts",
      featureSwitches: {
        [FeatureSwitchKey.Artifacts]: true,
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Artifacts" }),
      ).toBeInTheDocument();
      expect(linkByText("Artifacts")).toBeInTheDocument();
    });
    expect(screen.getByText("launch-plan.html")).toBeInTheDocument();
    expect(screen.getByText("text/html")).toBeInTheDocument();
    expect(screen.getByText("hosted site")).toBeInTheDocument();
    expect(screen.getByText("Synced to Google Drive")).toBeInTheDocument();
  });

  it("sends search and single-agent filter params to the Artifacts API", async () => {
    setupTeam();
    const queries: ArtifactsListQuery[] = [];
    context.mocks.api(artifactsContract.list, ({ query, respond }) => {
      queries.push(query);
      return respond(200, {
        artifacts: [
          createArtifact({
            artifactItemId: "run-brief:file-1",
            agentId: query.agentId ?? ZERO_AGENT_ID,
            agentName:
              query.agentId === RESEARCH_AGENT_ID ? "Research Agent" : "Zero",
            filename: query.query ? "brief.html" : "launch-plan.html",
          }),
        ],
        nextCursor: null,
      });
    });

    detachedSetupPage({
      context,
      path: "/artifacts",
      featureSwitches: {
        [FeatureSwitchKey.Artifacts]: true,
      },
    });

    await screen.findByText("launch-plan.html");
    await fill(screen.getByLabelText("Search artifacts"), "brief");

    await waitFor(() => {
      expect(
        queries.some((query) => {
          return query.query === "brief";
        }),
      ).toBeTruthy();
    });

    click(screen.getByLabelText("Agent filter"));
    click(await screen.findByRole("option", { name: "Research Agent" }));

    await waitFor(() => {
      expect(
        queries.some((query) => {
          return query.query === "brief" && query.agentId === RESEARCH_AGENT_ID;
        }),
      ).toBeTruthy();
    });
  });

  it("navigates to the source chat session", async () => {
    setupTeam();
    mockArtifacts([createArtifact()]);

    detachedSetupPage({
      context,
      path: "/artifacts",
      featureSwitches: {
        [FeatureSwitchKey.Artifacts]: true,
      },
    });

    await screen.findByText("launch-plan.html");
    click(buttonByText("Open chat"));

    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${SOURCE_THREAD_ID}`);
    });
  });
});
