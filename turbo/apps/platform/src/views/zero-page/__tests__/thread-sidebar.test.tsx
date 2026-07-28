import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  artifactCatalogContract,
  type ArtifactDetail,
  type ArtifactSummary,
} from "@vm0/api-contracts/contracts/artifact-catalog";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import {
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatThreadArtifactFile,
  type ChatEventResponse,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000050";
const THREAD_PATH = `/chats/${THREAD_ID}`;
const ARTIFACT_ID = "a0000000-0000-4000-a000-000000000001";

function catalogArtifact(
  overrides: Partial<ArtifactSummary> = {},
): ArtifactSummary {
  return {
    id: ARTIFACT_ID,
    kind: "file",
    title: "launch-plan.txt",
    thumbnail: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function catalogFileDetail({
  contentType,
  filename,
  fileId,
  summary,
  url,
}: {
  contentType: string;
  filename: string;
  fileId: string;
  summary: ArtifactSummary;
  url: string;
}): ArtifactDetail {
  return {
    ...summary,
    kind: "file",
    file: {
      id: fileId,
      filename,
      contentType,
      size: 1024,
      url,
      previewImageUrl: null,
    },
  };
}

function threadArtifactFile(
  url: string,
  overrides: Partial<ChatThreadArtifactFile> = {},
): ChatThreadArtifactFile {
  return {
    id: "artifact-release-notes",
    filename: "release-notes.md",
    contentType: "text/markdown",
    size: 42,
    url,
    createdAt: "2026-03-10T00:00:01Z",
    googleDriveSync: { status: "not_synced" },
    ...overrides,
  };
}

function googleDriveConnector(): ConnectorResponse {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "google-drive",
    authMethod: "oauth",
    externalId: "google-drive-external-id",
    externalUsername: "drive-user",
    externalEmail: "drive-user@example.com",
    oauthScopes: ["drive.file"],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function setupArtifactCatalog(
  artifacts: ArtifactSummary[],
  details: ReadonlyMap<string, ArtifactDetail>,
): void {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts, nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    const detail = details.get(params.artifactId);
    if (!detail) {
      return respond(404, {
        error: { message: "Artifact not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, detail);
  });
}

function setupChatThread({
  artifactFiles = [],
}: {
  artifactFiles?: ChatThreadArtifactFile[];
} = {}) {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);

  const messages: ChatEventResponse[] = [
    {
      id: "msg-sidebar-user",
      threadId: THREAD_ID,
      eventType: "input.prompt",
      content: "Build the launch plan",
      runId: "run-sidebar",
      seqId: 1,
      createdAt: "2026-03-10T00:00:00Z",
    },
    {
      id: "msg-sidebar-completed",
      threadId: THREAD_ID,
      eventType: "run.completed",
      content: null,
      runId: "run-sidebar",
      runLifecycleEvent: "completed",
      seqId: 2,
      createdAt: "2026-03-10T00:00:02Z",
    },
  ];

  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, { lastReadAt: null });
  });
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [
        {
          id: THREAD_ID,
          agentId: AGENT_ID,
          title: "Sidebar thread",
          sortAt: "2026-03-10T00:00:02Z",
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:02Z",
          pinnedAt: null,
          renamedAt: null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
        },
      ],
      latestEventId: "00000000-0000-4000-8000-000000000001",
      latestSeqId: 1,
    });
  });
  context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
    if (query.sinceSeqId || query.beforeSeqId) {
      return respond(200, { events: [] });
    }
    return respond(200, { events: messages, hasHistoryBefore: false });
  });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, {
      runs: [{ runId: "run-sidebar", files: artifactFiles }],
    });
  });

  detachedSetupPage({
    context,
    path: THREAD_PATH,
  });
}

async function openArtifactsFromHeader(): Promise<void> {
  const button = await waitFor(() => {
    const found = queryAllByRoleFast("button").find((element) => {
      return element.getAttribute("aria-label") === "Open artifacts";
    });
    if (!found) {
      throw new Error("Expected the artifacts header button");
    }
    return found;
  });
  click(button);
}

async function openCatalogArtifact(title: string): Promise<void> {
  await openArtifactsFromHeader();
  click(await screen.findByLabelText(`Preview ${title}`));
  await waitFor(() => {
    expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
  });
}

function menuItemByText(text: string): HTMLElement {
  const menuItems = queryAllByRoleFast("menuitem");
  const item = menuItems.find((element) => {
    return element.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

describe("thread-owned utility sidebar", () => {
  it("opens the thread-scoped catalog list", async () => {
    const requestedThreadIds: (string | undefined)[] = [];
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      requestedThreadIds.push(query.chatThreadId);
      return respond(200, {
        artifacts: [catalogArtifact()],
        nextCursor: null,
      });
    });

    setupChatThread();
    await openArtifactsFromHeader();

    await waitFor(() => {
      expect(
        screen.getByTestId("thread-sidebar-artifacts"),
      ).toBeInTheDocument();
    });
    await screen.findByLabelText("Preview launch-plan.txt");
    expect(requestedThreadIds).toContain(THREAD_ID);
  });

  it("shows an unavailable artifact detail with a way back to the list", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [catalogArtifact()],
        nextCursor: null,
      });
    });
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(404, {
        error: { message: "Artifact not found", code: "NOT_FOUND" },
      });
    });

    setupChatThread();
    await openArtifactsFromHeader();
    click(await screen.findByLabelText("Preview launch-plan.txt"));

    await waitFor(() => {
      expect(
        screen.getByTestId("thread-sidebar-artifact-unavailable"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Back to artifacts"));
    await waitFor(() => {
      expect(
        screen.getByTestId("thread-sidebar-artifacts"),
      ).toBeInTheDocument();
    });
  });

  it("connects the agent and syncs a catalog artifact to Google Drive", async () => {
    const user = userEvent.setup({ delay: null });
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-sidebar/drive-agent-notes.md";
    const summary = catalogArtifact({ title: "drive-agent-notes.md" });
    const artifactFiles = [
      threadArtifactFile(markdownUrl, {
        id: "artifact-drive-agent-notes",
        filename: "drive-agent-notes.md",
        googleDriveSync: { status: "disconnected" },
      }),
    ];

    setupArtifactCatalog(
      [summary],
      new Map([
        [
          summary.id,
          catalogFileDetail({
            contentType: "text/markdown",
            filename: "drive-agent-notes.md",
            fileId: "f0000000-0000-4000-a000-000000000001",
            summary,
            url: markdownUrl,
          }),
        ],
      ]),
    );
    context.mocks.data.connectors([googleDriveConnector()]);
    context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
      return respond(200, { connectors: [] });
    });
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Agent notes\n\nThe artifact is ready.", {
        headers: { "Content-Type": "text/plain" },
      });
    });

    let enabledTypes: string[] = [];
    let agentAuthorized = false;
    let artifactSynced = false;
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes });
    });
    context.mocks.api(
      zeroUserConnectorsContract.update,
      ({ body, params, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        expect(body).toStrictEqual({
          enabledTypes: ["google-drive"],
          operation: "add",
        });
        enabledTypes = [...body.enabledTypes];
        agentAuthorized = true;
        return respond(200, { enabledTypes });
      },
    );
    context.mocks.api(
      chatThreadArtifactsContract.syncGoogleDrive,
      ({ body, respond }) => {
        expect(enabledTypes).toStrictEqual(["google-drive"]);
        expect(body).toStrictEqual({
          runId: "run-sidebar",
          fileId: "artifact-drive-agent-notes",
        });
        artifactFiles[0] = {
          ...artifactFiles[0]!,
          googleDriveSync: {
            status: "synced",
            id: "drive-file-agent-notes",
            name: "drive-agent-notes.md",
            webViewLink: "https://drive.test/drive-agent-notes",
          },
        };
        artifactSynced = true;
        return respond(200, {
          id: "drive-file-agent-notes",
          name: "drive-agent-notes.md",
          webViewLink: "https://drive.test/drive-agent-notes",
        });
      },
    );

    setupChatThread({ artifactFiles });
    await openCatalogArtifact("drive-agent-notes.md");
    await screen.findByText("The artifact is ready.");

    await user.click(screen.getByLabelText("Download artifact"));
    await waitFor(() => {
      expect(menuItemByText("Connect Google Drive")).toBeEnabled();
    });
    await user.click(menuItemByText("Connect Google Drive"));

    await waitFor(() => {
      expect(agentAuthorized).toBeTruthy();
      expect(artifactSynced).toBeTruthy();
      expect(screen.getByText("Synced to Google Drive")).toBeInTheDocument();
    });
  });

  it("shows empty and unavailable CSV states from catalog details", async () => {
    const emptyCsvUrl =
      "https://cdn.vm7.io/artifacts/test/run-sidebar/empty.csv";
    const failedCsvUrl =
      "https://cdn.vm7.io/artifacts/test/run-sidebar/failed-metrics.csv";
    const emptySummary = catalogArtifact({ title: "empty.csv" });
    const failedSummary = catalogArtifact({
      id: "a0000000-0000-4000-a000-000000000002",
      title: "failed-metrics.csv",
    });

    setupArtifactCatalog(
      [emptySummary, failedSummary],
      new Map([
        [
          emptySummary.id,
          catalogFileDetail({
            contentType: "text/csv",
            filename: "empty.csv",
            fileId: "f0000000-0000-4000-a000-000000000002",
            summary: emptySummary,
            url: emptyCsvUrl,
          }),
        ],
        [
          failedSummary.id,
          catalogFileDetail({
            contentType: "text/csv",
            filename: "failed-metrics.csv",
            fileId: "f0000000-0000-4000-a000-000000000003",
            summary: failedSummary,
            url: failedCsvUrl,
          }),
        ],
      ]),
    );
    context.mocks.http.get(emptyCsvUrl, () => {
      return new Response("", {
        headers: { "Content-Type": "text/csv" },
      });
    });
    context.mocks.http.get(failedCsvUrl, () => {
      return new Response(null, { status: 503 });
    });
    setupChatThread({
      artifactFiles: [
        threadArtifactFile(emptyCsvUrl, {
          id: "artifact-empty-csv",
          filename: "empty.csv",
          contentType: "text/csv",
        }),
        threadArtifactFile(failedCsvUrl, {
          id: "artifact-failed-csv",
          filename: "failed-metrics.csv",
          contentType: "text/csv",
        }),
      ],
    });

    await openCatalogArtifact("empty.csv");
    await expect(screen.findByText("Empty CSV.")).resolves.toBeInTheDocument();

    click(screen.getByLabelText("Back to all artifacts"));
    await screen.findByTestId("thread-sidebar-artifacts");
    click(await screen.findByLabelText("Preview failed-metrics.csv"));

    await expect(
      screen.findByText("CSV preview unavailable."),
    ).resolves.toBeInTheDocument();
  });

  it("keeps image zoom controls available on catalog details", async () => {
    const user = userEvent.setup({ delay: null });
    const imageUrl =
      "https://cdn.vm7.io/artifacts/test/run-sidebar/launch-visual.png";
    const summary = catalogArtifact({
      kind: "image",
      title: "launch-visual.png",
    });
    const detail: ArtifactDetail = {
      ...summary,
      kind: "image",
      file: {
        id: "f0000000-0000-4000-a000-000000000004",
        filename: "launch-visual.png",
        contentType: "image/png",
        size: 2048,
        url: imageUrl,
        previewImageUrl: null,
      },
      model: null,
      provider: null,
    };

    setupArtifactCatalog([summary], new Map([[summary.id, detail]]));
    setupChatThread({
      artifactFiles: [
        threadArtifactFile(imageUrl, {
          id: "artifact-launch-visual",
          filename: "launch-visual.png",
          contentType: "image/png",
        }),
      ],
    });

    await openCatalogArtifact("launch-visual.png");
    const zoomLevel = screen.getByTestId("artifact-sidebar-image-zoom-level");
    expect(zoomLevel).toHaveTextContent("100%");

    await user.click(screen.getByTestId("artifact-sidebar-image-zoom-in"));
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("115%");
    });

    await user.click(screen.getByTestId("artifact-sidebar-image-reset-zoom"));
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("100%");
    });
  });
});
