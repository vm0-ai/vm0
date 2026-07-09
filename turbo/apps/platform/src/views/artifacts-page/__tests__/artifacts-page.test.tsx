import { screen, waitFor } from "@testing-library/react";
import {
  artifactsContract,
  type ArtifactItem,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it, vi } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { openChatIdb } from "../../../signals/external/chat-idb-store.ts";
import { createArtifactItemCacheStores } from "../../../signals/external/idb-artifact-item-store.ts";

const artifactIdbMock = vi.hoisted(() => {
  interface StoredObjectStore {
    readonly keyPath: string;
    readonly rows: Map<string, Record<string, unknown>>;
  }

  interface IndexedRow {
    readonly key: IDBValidKey;
    readonly value: Record<string, unknown>;
  }

  class MemoryCursor {
    private position = 0;

    constructor(private readonly values: readonly Record<string, unknown>[]) {}

    get value(): unknown {
      return this.values[this.position];
    }

    continue(): Promise<MemoryCursor | null> {
      this.position += 1;
      return Promise.resolve(this.position < this.values.length ? this : null);
    }
  }

  function compareIdbKeys(left: IDBValidKey, right: IDBValidKey): number {
    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.min(left.length, right.length);
      for (let index = 0; index < length; index += 1) {
        const comparison = compareIdbKeys(left[index]!, right[index]!);
        if (comparison !== 0) {
          return comparison;
        }
      }
      return left.length - right.length;
    }

    if (Array.isArray(left)) {
      return 1;
    }
    if (Array.isArray(right)) {
      return -1;
    }
    if (left instanceof Date && right instanceof Date) {
      return left.getTime() - right.getTime();
    }
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    if (typeof left === "string" && typeof right === "string") {
      if (left < right) {
        return -1;
      }
      if (left > right) {
        return 1;
      }
    }
    return 0;
  }

  function keyMatchesRange(
    range: IDBKeyRange | undefined,
    key: IDBValidKey,
  ): boolean {
    return range === undefined || range.includes(key);
  }

  function artifactIndexKey(
    indexName: string,
    item: Record<string, unknown>,
  ): IDBValidKey | null {
    switch (indexName) {
      case "byCreatedAt": {
        return [item.createdAt as string, item.artifactItemId as string];
      }
      case "byAgentCreatedAt": {
        return [
          item.agentId as string,
          item.createdAt as string,
          item.artifactItemId as string,
        ];
      }
      case "byArtifactKindCreatedAt": {
        return typeof item.artifactKind === "string"
          ? [
              item.artifactKind,
              item.createdAt as string,
              item.artifactItemId as string,
            ]
          : null;
      }
      case "byAgentKindCreatedAt": {
        return typeof item.artifactKind === "string"
          ? [
              item.agentId as string,
              item.artifactKind,
              item.createdAt as string,
              item.artifactItemId as string,
            ]
          : null;
      }
      case "byRunFile": {
        return [item.runId as string, item.fileId as string];
      }
      default: {
        return null;
      }
    }
  }

  class MemoryObjectStore {
    constructor(private readonly store: StoredObjectStore) {}

    put(value: Record<string, unknown>): Promise<void> {
      const key = value[this.store.keyPath];
      if (typeof key === "string") {
        this.store.rows.set(key, value);
      }
      return Promise.resolve();
    }

    delete(key: IDBValidKey): Promise<void> {
      if (typeof key === "string") {
        this.store.rows.delete(key);
      }
      return Promise.resolve();
    }

    clear(): Promise<void> {
      for (const key of this.store.rows.keys()) {
        this.store.rows.delete(key);
      }
      return Promise.resolve();
    }

    get(key: IDBValidKey): Promise<unknown> {
      return Promise.resolve(
        typeof key === "string" ? this.store.rows.get(key) : undefined,
      );
    }

    createIndex(): void {
      return undefined;
    }

    index(indexName: string): {
      get: (key: IDBValidKey) => Promise<unknown>;
      openCursor: (
        range?: IDBKeyRange,
        direction?: IDBCursorDirection,
      ) => Promise<MemoryCursor | null>;
    } {
      return {
        get: (key) => {
          return Promise.resolve(
            this.indexedRows(indexName).find((row) => {
              return compareIdbKeys(row.key, key) === 0;
            })?.value,
          );
        },
        openCursor: (range, direction) => {
          const rows = this.indexedRows(indexName).filter((row) => {
            return keyMatchesRange(range, row.key);
          });
          rows.sort((left, right) => {
            return compareIdbKeys(left.key, right.key);
          });
          if (direction === "prev" || direction === "prevunique") {
            rows.reverse();
          }
          if (rows.length === 0) {
            return Promise.resolve(null);
          }
          return Promise.resolve(
            new MemoryCursor(
              rows.map((row) => {
                return row.value;
              }),
            ),
          );
        },
      };
    }

    private indexedRows(indexName: string): IndexedRow[] {
      if (this.store.keyPath !== "artifactItemId") {
        return [];
      }
      return Array.from(this.store.rows.values()).flatMap((item) => {
        const key = artifactIndexKey(indexName, item);
        return key === null ? [] : [{ key, value: item }];
      });
    }
  }

  class MemoryDb {
    private readonly stores = new Map<string, StoredObjectStore>();

    readonly objectStoreNames = {
      contains: (storeName: string) => {
        return this.stores.has(storeName);
      },
    };

    createObjectStore(
      storeName: string,
      options?: { readonly keyPath?: string },
    ): MemoryObjectStore {
      return this.ensureStore(storeName, options?.keyPath ?? "id");
    }

    deleteObjectStore(storeName: string): void {
      this.stores.delete(storeName);
    }

    transaction(storeName: string): {
      readonly store: MemoryObjectStore;
      readonly done: Promise<void>;
      objectStore: () => MemoryObjectStore;
    } {
      const store = this.ensureStore(
        storeName,
        storeName === "artifact_items" ? "artifactItemId" : "id",
      );
      return {
        store,
        done: Promise.resolve(),
        objectStore: () => {
          return store;
        },
      };
    }

    addEventListener(): void {
      return undefined;
    }

    close(): void {
      return undefined;
    }

    private ensureStore(storeName: string, keyPath: string): MemoryObjectStore {
      const existing = this.stores.get(storeName);
      if (existing !== undefined) {
        return new MemoryObjectStore(existing);
      }
      const store = {
        keyPath,
        rows: new Map<string, Record<string, unknown>>(),
      };
      this.stores.set(storeName, store);
      return new MemoryObjectStore(store);
    }
  }

  const dbs = new Map<string, MemoryDb>();

  return {
    async openDB(
      name: string,
      _version?: number,
      callbacks?: {
        readonly upgrade?: (db: MemoryDb, oldVersion: number) => void;
      },
    ): Promise<MemoryDb> {
      await Promise.resolve();
      const existing = dbs.get(name);
      if (existing !== undefined) {
        return existing;
      }
      const db = new MemoryDb();
      dbs.set(name, db);
      callbacks?.upgrade?.(db, 0);
      return db;
    },
  };
});

vi.mock("idb", () => {
  return {
    openDB: artifactIdbMock.openDB,
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
    return respond(200, {
      artifacts: [...artifacts],
      truncated: false,
      nextCursor: null,
    });
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

function resolvedChatIdb(db: Awaited<ReturnType<typeof openChatIdb>>) {
  return async () => {
    await Promise.resolve();
    return db;
  };
}

async function seedCachedArtifacts(
  scope: TestAuthScope,
  artifacts: readonly ArtifactItem[],
): Promise<void> {
  const db = await openChatIdb(scope.userId, scope.orgId);
  const stores = createArtifactItemCacheStores(resolvedChatIdb(db));
  await stores.writeStore.replaceItems(artifacts);
  const seeded = await stores.readStore.readRecent({ limit: 10_000 });
  if (seeded.length !== artifacts.length) {
    throw new Error("Expected artifact cache seed to be readable");
  }
}

async function cachedArtifactIds(scope: TestAuthScope): Promise<string[]> {
  const db = await openChatIdb(scope.userId, scope.orgId);
  const artifacts = await createArtifactItemCacheStores(
    resolvedChatIdb(db),
  ).readStore.readRecent({ limit: 10_000 });
  return artifacts.map((artifact) => {
    return artifact.artifactItemId;
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
  it("hides the entry and redirects when the feature switch is disabled", async () => {
    setupTeam();
    const scope = testAuthScope("disabled");
    let requested = false;
    context.mocks.api(artifactsContract.list, ({ respond }) => {
      requested = true;
      return respond(200, {
        artifacts: [],
        truncated: false,
        nextCursor: null,
      });
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

  it("renders static preview images while preserving the HTML iframe fallback", async () => {
    setupTeam();
    const scope = testAuthScope("preview-image");
    const previewImageUrl =
      "https://cdn.vm7.io/artifacts/user/artifact-row/preview-deploy.webp";
    mockArtifacts([
      createArtifact({
        artifactItemId: "static-run:file-1",
        runId: "static-run",
        filename: "static-preview.html",
        previewImageUrl,
      }),
      createArtifact({
        artifactItemId: "fallback-run:file-1",
        runId: "fallback-run",
        fileId: "fallback-file",
        filename: "fallback-preview.html",
        url: "https://artifacts.example.com/fallback-preview.html",
      }),
    ]);

    setupArtifactsPage({ scope });

    await screen.findByText("static-preview.html");
    await screen.findByText("fallback-preview.html");
    const previewImages = Array.from(document.querySelectorAll("img")).filter(
      (image) => {
        return image.getAttribute("src") === previewImageUrl;
      },
    );
    expect(previewImages).toHaveLength(1);
    expect(screen.queryByTitle("static-preview.html preview")).toBeNull();
    expect(screen.getByTitle("fallback-preview.html preview")).toHaveAttribute(
      "src",
      "https://artifacts.example.com/fallback-preview.html",
    );
  });

  it("renders video poster images with a play affordance while preserving the video fallback", async () => {
    setupTeam();
    const scope = testAuthScope("video-preview-image");
    const posterUrl = "https://cdn.vm7.io/artifacts/user/video-row/poster.jpg";
    const fallbackVideoUrl = "https://artifacts.example.com/fallback-video.mp4";
    mockArtifacts([
      createArtifact({
        artifactItemId: "poster-run:file-video",
        runId: "poster-run",
        fileId: "poster-file",
        filename: "poster-video.mp4",
        contentType: "video/mp4",
        url: "https://artifacts.example.com/poster-video.mp4",
        artifactKind: undefined,
        previewImageUrl: posterUrl,
      }),
      createArtifact({
        artifactItemId: "fallback-video-run:file-video",
        runId: "fallback-video-run",
        fileId: "fallback-video-file",
        filename: "fallback-video.mp4",
        contentType: "video/mp4",
        url: fallbackVideoUrl,
        artifactKind: undefined,
      }),
    ]);

    setupArtifactsPage({ scope });

    await screen.findByText("poster-video.mp4");
    await screen.findByText("fallback-video.mp4");
    const posterImages = Array.from(document.querySelectorAll("img")).filter(
      (image) => {
        return image.getAttribute("src") === posterUrl;
      },
    );
    expect(posterImages).toHaveLength(1);
    expect(
      document.querySelector(".tabler-icon-player-play-filled"),
    ).toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll("video")).some((video) => {
        return (
          video.getAttribute("src") ===
          "https://artifacts.example.com/poster-video.mp4"
        );
      }),
    ).toBeFalsy();
    expect(
      Array.from(document.querySelectorAll("video")).some((video) => {
        return video.getAttribute("src") === fallbackVideoUrl;
      }),
    ).toBeTruthy();
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
            artifactItemId: "run-video:file-1",
            runId: "run-video",
            fileId: "file-video",
            filename: "launch-video.mp4",
            contentType: "video/mp4",
            artifactKind: undefined,
          }),
          createArtifact({
            artifactItemId: "run-archive:file-1",
            runId: "run-archive",
            fileId: "file-archive",
            filename: "launch-assets.zip",
            contentType: "application/zip",
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
        nextCursor: null,
      });
    });

    setupArtifactsPage({ scope });

    await screen.findByText("launch-plan.html");
    await screen.findByText("launch-image.png");
    await screen.findByText("launch-video.mp4");
    await screen.findByText("launch-assets.zip");
    await screen.findByText("research-brief.html");

    click(buttonByLabel("Show image artifacts"));
    await waitFor(() => {
      expect(screen.queryByText("launch-plan.html")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-video.mp4")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-assets.zip")).not.toBeInTheDocument();
      expect(screen.queryByText("research-brief.html")).not.toBeInTheDocument();
      expect(screen.getByText("launch-image.png")).toBeInTheDocument();
    });

    click(buttonByLabel("Show video artifacts"));
    await waitFor(() => {
      expect(screen.queryByText("launch-plan.html")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-image.png")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-assets.zip")).not.toBeInTheDocument();
      expect(screen.queryByText("research-brief.html")).not.toBeInTheDocument();
      expect(screen.getByText("launch-video.mp4")).toBeInTheDocument();
    });

    click(buttonByLabel("Show other artifacts"));
    await waitFor(() => {
      expect(screen.queryByText("launch-plan.html")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-image.png")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-video.mp4")).not.toBeInTheDocument();
      expect(screen.queryByText("research-brief.html")).not.toBeInTheDocument();
      expect(screen.getByText("launch-assets.zip")).toBeInTheDocument();
    });

    click(buttonByLabel("Show all artifacts"));
    await fill(screen.getByLabelText("Search artifacts"), "brief");
    await waitFor(() => {
      expect(screen.getByText("research-brief.html")).toBeInTheDocument();
      expect(screen.queryByText("launch-plan.html")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-image.png")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-video.mp4")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-assets.zip")).not.toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Search artifacts"), "");
    click(screen.getByLabelText("Agent filter"));
    click(await screen.findByRole("option", { name: "Research Agent" }));
    await waitFor(() => {
      expect(screen.getByText("research-brief.html")).toBeInTheDocument();
      expect(screen.queryByText("launch-plan.html")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-image.png")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-video.mp4")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-assets.zip")).not.toBeInTheDocument();
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
    await seedCachedArtifacts(scope, [
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
    await waitFor(async () => {
      await expect(cachedArtifactIds(scope)).resolves.toStrictEqual([
        artifact.artifactItemId,
      ]);
    });
  });

  it("replaces stale cached artifacts after a successful remote refresh", async () => {
    setupTeam();
    const scope = testAuthScope("remote-cache-replace");
    const staleArtifact = createArtifact({
      artifactItemId: "stale-run:file-1",
      runId: "stale-run",
      filename: "stale-summary.html",
      createdAt: "2026-01-02T00:00:00Z",
    });
    const remoteArtifact = createArtifact({
      artifactItemId: "fresh-run:file-1",
      runId: "fresh-run",
      filename: "fresh-summary.html",
      createdAt: "2026-01-03T00:00:00Z",
    });
    await seedCachedArtifacts(scope, [staleArtifact]);
    mockArtifacts([remoteArtifact]);

    setupArtifactsPage({ scope });

    await screen.findByText("fresh-summary.html");
    await waitFor(() => {
      expect(screen.queryByText("stale-summary.html")).not.toBeInTheDocument();
    });
    await waitFor(async () => {
      await expect(cachedArtifactIds(scope)).resolves.toStrictEqual([
        remoteArtifact.artifactItemId,
      ]);
    });
  });

  it("falls back to cached artifacts when the remote refresh fails", async () => {
    setupTeam();
    const scope = testAuthScope("remote-error");
    await seedCachedArtifacts(scope, [
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

  it("loads every artifact by following keyset pagination cursors", async () => {
    setupTeam();
    const scope = testAuthScope("paged");
    context.mocks.api(artifactsContract.list, ({ query, respond }) => {
      if (!query.cursor) {
        return respond(200, {
          artifacts: [
            createArtifact({
              artifactItemId: "page-one:file-1",
              runId: "page-one",
              filename: "page-one.html",
            }),
          ],
          truncated: false,
          nextCursor: "cursor-page-2",
        });
      }
      return respond(200, {
        artifacts: [
          createArtifact({
            artifactItemId: "page-two:file-1",
            runId: "page-two",
            filename: "page-two.html",
          }),
        ],
        truncated: false,
        nextCursor: null,
      });
    });

    setupArtifactsPage({ scope });

    // Both pages surface, proving the client walks nextCursor to the end
    // instead of stopping at the first (capped) response.
    await screen.findByText("page-one.html");
    await screen.findByText("page-two.html");
  });

  it("windows a large set behind a load more control", async () => {
    setupTeam();
    const scope = testAuthScope("windowed");
    const many = Array.from({ length: 65 }, (_, index) => {
      const label = String(index).padStart(2, "0");
      return createArtifact({
        artifactItemId: `windowed-${label}:file`,
        runId: `windowed-${label}`,
        filename: `windowed-${label}.html`,
        createdAt: `2026-01-01T00:${label}:00Z`,
      });
    });
    mockArtifacts(many);

    setupArtifactsPage({ scope });

    // The first window renders; the tail stays hidden until "Load more".
    await screen.findByText("windowed-00.html");
    expect(screen.queryByText("windowed-64.html")).not.toBeInTheDocument();

    const loadMoreButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.trim() === "Load more";
    });
    if (!loadMoreButton) {
      throw new Error("Load more button not found");
    }
    click(loadMoreButton);

    await screen.findByText("windowed-64.html");
  });
});
