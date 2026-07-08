import { screen, waitFor } from "@testing-library/react";
import {
  artifactsContract,
  type ArtifactItem,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { ArtifactCategory } from "../../../signals/artifacts-page/artifact-category.ts";

const idbArtifactStoreMock = vi.hoisted(() => {
  type CachedArtifact = Record<string, unknown> & {
    readonly artifactItemId?: unknown;
    readonly agentId?: unknown;
    readonly filename?: unknown;
    readonly contentType?: unknown;
    readonly artifactKind?: unknown;
    readonly artifactCategory?: unknown;
    readonly runId?: unknown;
    readonly fileId?: unknown;
  };

  let cachedArtifacts: CachedArtifact[] = [];

  function searchableText(item: CachedArtifact): string {
    return [item.filename, item.contentType, item.artifactKind]
      .filter((value): value is string => {
        return typeof value === "string";
      })
      .join("\n")
      .toLowerCase();
  }

  const readRecent = vi.fn(
    (filter?: {
      readonly agentId?: string;
      readonly artifactCategory?: ArtifactCategory;
      readonly query?: string;
      readonly limit?: number;
    }) => {
      const queryTokens =
        filter?.query
          ?.trim()
          .toLowerCase()
          .split(/\s+/)
          .filter((token) => {
            return token.length > 0;
          }) ?? [];
      const limit = filter?.limit ?? 50;
      return Promise.resolve(
        cachedArtifacts
          .filter((item) => {
            if (
              filter?.agentId &&
              typeof item.agentId === "string" &&
              item.agentId !== filter.agentId
            ) {
              return false;
            }
            const text = searchableText(item);
            if (
              filter?.artifactCategory === "image" &&
              typeof item.contentType === "string" &&
              !item.contentType.startsWith("image/")
            ) {
              return false;
            }
            if (
              filter?.artifactCategory === "website" &&
              item.artifactKind !== "hosted-site"
            ) {
              return false;
            }
            return queryTokens.every((token) => {
              return text.includes(token);
            });
          })
          .slice(0, limit),
      );
    },
  );

  const readByRunFile = vi.fn((runId: string, fileId: string) => {
    return Promise.resolve(
      cachedArtifacts.find((item) => {
        return item.runId === runId && item.fileId === fileId;
      }) ?? null,
    );
  });

  const upsertItems = vi.fn((items: readonly CachedArtifact[]) => {
    for (const item of items) {
      const index = cachedArtifacts.findIndex((cached) => {
        return cached.artifactItemId === item.artifactItemId;
      });
      if (index === -1) {
        cachedArtifacts.push(item);
      } else {
        cachedArtifacts[index] = item;
      }
    }
    return Promise.resolve();
  });

  return {
    readRecent,
    readByRunFile,
    upsertItems,
    setItems(items: readonly CachedArtifact[]) {
      cachedArtifacts = [...items];
    },
    items() {
      return cachedArtifacts;
    },
    reset() {
      cachedArtifacts = [];
      readRecent.mockClear();
      readByRunFile.mockClear();
      upsertItems.mockClear();
    },
  };
});

vi.mock("../../../signals/external/idb-artifact-item-store.ts", () => {
  return {
    createIdbArtifactItemStores: () => {
      return {
        readStore: {
          readRecent: idbArtifactStoreMock.readRecent,
          readByRunFile: idbArtifactStoreMock.readByRunFile,
        },
        writeStore: {
          upsertItems: idbArtifactStoreMock.upsertItems,
          deleteItems: vi.fn(() => {
            return Promise.resolve();
          }),
          clear: vi.fn(() => {
            return Promise.resolve();
          }),
        },
      };
    },
  };
});

const context = testContext();

const ZERO_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const SOURCE_THREAD_ID = "b0000000-0000-4000-a000-000000000001";

interface TestAuthScope {
  readonly userId: string;
  readonly orgId: string;
}

function testAuthScope(name: string): TestAuthScope {
  return {
    userId: `test-user-artifacts-${name}`,
    orgId: `org_artifacts_${name}`,
  };
}

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
    ...overrides,
  };
}

function mockArtifacts(artifacts: readonly ArtifactItem[]): void {
  context.mocks.api(artifactsContract.list, ({ respond }) => {
    return respond(200, { artifacts: [...artifacts], truncated: false });
  });
}

function setupArtifactsPage({
  scope,
  enabled = true,
}: {
  readonly scope: TestAuthScope;
  readonly enabled?: boolean;
}): void {
  detachedSetupPage({
    context,
    path: "/artifacts",
    user: {
      id: scope.userId,
      fullName: "Test User",
    },
    org: {
      activeOrg: { id: scope.orgId, name: "Test Org" },
      memberships: [{ id: scope.orgId }],
    },
    featureSwitches: {
      [FeatureSwitchKey.Artifacts]: enabled,
    },
  });
}

async function seedCachedArtifacts(
  artifacts: readonly ArtifactItem[],
): Promise<void> {
  idbArtifactStoreMock.setItems(artifacts);
  await Promise.resolve();
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

function buttonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

describe("artifacts page", () => {
  afterEach(() => {
    idbArtifactStoreMock.reset();
  });

  it("hides the entry and redirects when the feature switch is disabled", async () => {
    setupTeam();
    const scope = testAuthScope("disabled");
    let requested = false;
    context.mocks.api(artifactsContract.list, ({ respond }) => {
      requested = true;
      return respond(200, { artifacts: [], truncated: false });
    });

    setupArtifactsPage({ scope, enabled: false });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${ZERO_AGENT_ID}/chat`);
    });
    expect(requested).toBeFalsy();
    expect(queryLinkByText("Artifacts")).toBeUndefined();
  });

  it("shows the Manage entry and renders artifact metadata when enabled", async () => {
    setupTeam();
    const scope = testAuthScope("metadata");
    const createdAt = "2026-01-15T12:00:00Z";
    mockArtifacts([createArtifact({ createdAt })]);
    const formattedCreatedAt = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(createdAt));

    setupArtifactsPage({ scope });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Artifacts" }),
      ).toBeInTheDocument();
      expect(linkByText("Artifacts")).toBeInTheDocument();
    });
    expect(screen.getByText("launch-plan.html")).toBeInTheDocument();
    expect(screen.queryByText("Zero · Launch plan")).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Search artifacts..."),
    ).toBeInTheDocument();
    expect(screen.queryByText("text/html")).not.toBeInTheDocument();
    expect(
      screen.getByText(`hosted site · ${formattedCreatedAt}`),
    ).toBeInTheDocument();
    expect(screen.getByTitle("launch-plan.html preview")).toHaveStyle({
      height: "1280px",
      width: "1280px",
    });
  });

  it("filters category, search, and agent locally over the bulk-synced set", async () => {
    setupTeam();
    const scope = testAuthScope("filters");
    let listCalls = 0;
    context.mocks.api(artifactsContract.list, ({ respond }) => {
      listCalls += 1;
      return respond(200, {
        artifacts: [
          createArtifact({
            artifactItemId: "run-plan:file-1",
            runId: "run-plan",
            filename: "launch-plan.html",
          }),
          createArtifact({
            artifactItemId: "run-image:file-1",
            runId: "run-image",
            fileId: "file-image",
            filename: "launch-image.png",
            contentType: "image/png",
            artifactKind: undefined,
          }),
          createArtifact({
            artifactItemId: "run-brief:file-1",
            runId: "run-brief",
            fileId: "file-brief",
            agentId: RESEARCH_AGENT_ID,
            agentName: "Research Agent",
            filename: "research-brief.html",
          }),
        ],
        truncated: false,
      });
    });

    setupArtifactsPage({ scope });

    await screen.findByText("launch-plan.html");
    await screen.findByText("launch-image.png");
    await screen.findByText("research-brief.html");

    click(buttonByLabel("Show image artifacts"));
    await waitFor(() => {
      expect(screen.queryByText("launch-plan.html")).not.toBeInTheDocument();
      expect(screen.queryByText("research-brief.html")).not.toBeInTheDocument();
      expect(screen.getByText("launch-image.png")).toBeInTheDocument();
    });

    click(buttonByLabel("Show all artifacts"));
    await fill(screen.getByLabelText("Search artifacts"), "brief");
    await waitFor(() => {
      expect(screen.getByText("research-brief.html")).toBeInTheDocument();
      expect(screen.queryByText("launch-plan.html")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-image.png")).not.toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Search artifacts"), "");
    click(screen.getByLabelText("Agent filter"));
    click(await screen.findByRole("option", { name: "Research Agent" }));
    await waitFor(() => {
      expect(screen.getByText("research-brief.html")).toBeInTheDocument();
      expect(screen.queryByText("launch-plan.html")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-image.png")).not.toBeInTheDocument();
    });

    // All filtering was client-side: the bulk endpoint was hit once.
    expect(listCalls).toBe(1);
  });

  it("navigates to the source chat session", async () => {
    setupTeam();
    const scope = testAuthScope("navigate");
    mockArtifacts([createArtifact()]);

    setupArtifactsPage({ scope });

    await screen.findByText("launch-plan.html");
    click(buttonByLabel("Open source chat for launch-plan.html"));

    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${SOURCE_THREAD_ID}`);
    });
  });

  it("renders cached artifacts while the remote refresh is pending", async () => {
    setupTeam();
    const scope = testAuthScope("pending-refresh");
    await seedCachedArtifacts([
      createArtifact({
        artifactItemId: "cached-run:file-1",
        runId: "cached-run",
        filename: "cached-brief.html",
        createdAt: "2026-01-02T00:00:00Z",
      }),
    ]);
    context.mocks.api(artifactsContract.list, ({ never }) => {
      return never();
    });

    setupArtifactsPage({ scope });

    await expect(
      screen.findByText("cached-brief.html"),
    ).resolves.toBeInTheDocument();
  });

  it("writes remote artifacts to the IndexedDB cache", async () => {
    setupTeam();
    const scope = testAuthScope("remote-cache-fill");
    const artifact = createArtifact({
      artifactItemId: "remote-run:file-1",
      runId: "remote-run",
      filename: "remote-summary.html",
    });
    mockArtifacts([artifact]);

    setupArtifactsPage({ scope });

    await screen.findByText("remote-summary.html");
    await waitFor(() => {
      expect(
        idbArtifactStoreMock.items().some((item) => {
          return item.artifactItemId === artifact.artifactItemId;
        }),
      ).toBeTruthy();
    });
  });

  it("falls back to cached artifacts when the remote refresh fails", async () => {
    setupTeam();
    const scope = testAuthScope("remote-error");
    await seedCachedArtifacts([
      createArtifact({
        artifactItemId: "cached-error-run:file-1",
        runId: "cached-error-run",
        filename: "cached-after-error.html",
      }),
    ]);
    context.mocks.api(artifactsContract.list, ({ respond }) => {
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "Could not load artifacts",
        },
      });
    });

    setupArtifactsPage({ scope });

    await expect(
      screen.findByText("cached-after-error.html"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
