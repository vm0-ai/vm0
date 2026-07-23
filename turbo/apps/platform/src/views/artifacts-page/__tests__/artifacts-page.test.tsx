import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import {
  artifactsContract,
  chatThreadArtifactsContract,
  type ArtifactItem,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroAgentDraftContract } from "@vm0/api-contracts/contracts/zero-agents";
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

  let artifactReplacementGate: {
    readonly completed: PromiseWithResolvers<void>;
    readonly started: PromiseWithResolvers<void>;
    readonly released: PromiseWithResolvers<void>;
  } | null = null;
  let artifactReadGate: {
    readonly afterItems: number;
    readonly started: PromiseWithResolvers<void>;
    readonly released: PromiseWithResolvers<void>;
  } | null = null;

  class MemoryCursor {
    private position = 0;

    constructor(
      private readonly values: readonly Record<string, unknown>[],
      private readonly readGate: typeof artifactReadGate,
    ) {}

    get value(): unknown {
      return this.values[this.position];
    }

    async continue(): Promise<MemoryCursor | null> {
      if (this.readGate && this.position === this.readGate.afterItems - 1) {
        this.readGate.started.resolve();
        await this.readGate.released.promise;
      }
      this.position += 1;
      return this.position < this.values.length ? this : null;
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
    constructor(
      private readonly store: StoredObjectStore,
      private readonly transactionAborted: () => boolean = () => {
        return false;
      },
    ) {}

    put(value: Record<string, unknown>): Promise<void> {
      this.throwIfTransactionAborted();
      const key = value[this.store.keyPath];
      if (typeof key === "string") {
        this.store.rows.set(key, value);
      }
      return Promise.resolve();
    }

    delete(key: IDBValidKey): Promise<void> {
      this.throwIfTransactionAborted();
      if (typeof key === "string") {
        this.store.rows.delete(key);
      }
      return Promise.resolve();
    }

    async clear(): Promise<void> {
      const gate = artifactReplacementGate;
      if (this.store.keyPath === "artifactItemId" && gate) {
        artifactReplacementGate = null;
        gate.started.resolve();
        try {
          await gate.released.promise;
          this.throwIfTransactionAborted();
        } finally {
          gate.completed.resolve();
        }
      }
      this.throwIfTransactionAborted();
      for (const key of this.store.rows.keys()) {
        this.store.rows.delete(key);
      }
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
              this.store.keyPath === "artifactItemId" ? artifactReadGate : null,
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

    private throwIfTransactionAborted(): void {
      if (this.transactionAborted()) {
        throw new DOMException("Transaction aborted", "AbortError");
      }
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
      abort: () => void;
      readonly store: MemoryObjectStore;
      readonly done: Promise<void>;
      objectStore: () => MemoryObjectStore;
    } {
      const stored = this.ensureStoredObjectStore(
        storeName,
        storeName === "artifact_items" ? "artifactItemId" : "id",
      );
      let aborted = false;
      const store = new MemoryObjectStore(stored, () => {
        return aborted;
      });
      return {
        abort: () => {
          aborted = true;
        },
        store,
        done: Promise.resolve(),
        objectStore: () => {
          return store;
        },
      };
    }

    get(storeName: string, key: IDBValidKey): Promise<unknown> {
      return this.ensureStore(
        storeName,
        storeName === "artifact_items" ? "artifactItemId" : "id",
      ).get(key);
    }

    put(storeName: string, value: Record<string, unknown>): Promise<void> {
      return this.ensureStore(
        storeName,
        storeName === "artifact_items" ? "artifactItemId" : "id",
      ).put(value);
    }

    addEventListener(): void {
      return undefined;
    }

    close(): void {
      return undefined;
    }

    private ensureStore(storeName: string, keyPath: string): MemoryObjectStore {
      return new MemoryObjectStore(
        this.ensureStoredObjectStore(storeName, keyPath),
      );
    }

    private ensureStoredObjectStore(
      storeName: string,
      keyPath: string,
    ): StoredObjectStore {
      const existing = this.stores.get(storeName);
      if (existing !== undefined) {
        return existing;
      }
      const store = {
        keyPath,
        rows: new Map<string, Record<string, unknown>>(),
      };
      this.stores.set(storeName, store);
      return store;
    }
  }

  const dbs = new Map<string, MemoryDb>();

  return {
    blockArtifactCursorContinuation(afterItems = 1): {
      readonly started: Promise<void>;
      release(): void;
    } {
      const started = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const gate = { afterItems, started, released };
      artifactReadGate = gate;
      return {
        started: started.promise,
        release: () => {
          if (artifactReadGate === gate) {
            artifactReadGate = null;
          }
          released.resolve();
        },
      };
    },

    blockArtifactReplacement(): {
      readonly completed: Promise<void>;
      readonly started: Promise<void>;
      release(): void;
    } {
      const completed = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const gate = { completed, started, released };
      artifactReplacementGate = gate;
      return {
        completed: completed.promise,
        started: started.promise,
        release: () => {
          if (artifactReplacementGate === gate) {
            artifactReplacementGate = null;
          }
          released.resolve();
        },
      };
    },

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

function setupTeam(): void {
  context.mocks.data.team([
    createAgent(ZERO_AGENT_ID, "Zero"),
    createAgent(RESEARCH_AGENT_ID, "Research Agent"),
  ]);
}

function createArtifact(overrides: Partial<ArtifactItem> = {}): ArtifactItem {
  const artifactItemId = overrides.artifactItemId ?? "run-1:file-1";
  return {
    artifactItemId,
    threadId: SOURCE_THREAD_ID,
    runId: "run-1",
    fileId: "file-1",
    agentId: ZERO_AGENT_ID,
    agentName: "Zero",
    agentAvatarUrl: null,
    threadTitle: "Launch plan",
    filename: "launch-plan.html",
    contentType: "text/html",
    size: 9216,
    url:
      overrides.url ??
      (artifactItemId === "run-1:file-1"
        ? "https://artifacts.example.com/launch-plan.html"
        : `https://artifacts.example.com/${encodeURIComponent(artifactItemId)}`),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
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

function mockScrollViewport(
  element: HTMLElement,
  initial: {
    readonly clientHeight: number;
    readonly scrollHeight: number;
    readonly scrollTop: number;
  },
) {
  let metrics = initial;
  Object.defineProperties(element, {
    clientHeight: {
      configurable: true,
      get: () => {
        return metrics.clientHeight;
      },
    },
    scrollHeight: {
      configurable: true,
      get: () => {
        return metrics.scrollHeight;
      },
    },
    scrollTop: {
      configurable: true,
      get: () => {
        return metrics.scrollTop;
      },
      set: (scrollTop: number) => {
        metrics = { ...metrics, scrollTop };
      },
    },
  });
  return (next: Partial<typeof initial>) => {
    metrics = { ...metrics, ...next };
  };
}

function setupArtifactsPage({
  scope,
  enabled = true,
  htmlArtifactCommentEditingEnabled = false,
  imageEditingEnabled = false,
}: {
  readonly scope: TestAuthScope;
  readonly enabled?: boolean;
  readonly htmlArtifactCommentEditingEnabled?: boolean;
  readonly imageEditingEnabled?: boolean;
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
      [FeatureSwitchKey.HtmlArtifactCommentEditing]:
        htmlArtifactCommentEditingEnabled,
      [FeatureSwitchKey.ImageEditing]: imageEditingEnabled,
    },
  });
}

function resolvedChatIdb(db: Awaited<ReturnType<typeof openChatIdb>>) {
  return async () => {
    await Promise.resolve();
    return db;
  };
}

async function withChatIdb<T>(
  scope: TestAuthScope,
  operation: (db: Awaited<ReturnType<typeof openChatIdb>>) => Promise<T>,
): Promise<T> {
  const db = await openChatIdb(scope.userId, scope.orgId);
  try {
    return await operation(db);
  } finally {
    db.close();
  }
}

async function seedCachedArtifacts(
  scope: TestAuthScope,
  artifacts: readonly ArtifactItem[],
  lastSyncedAt?: string,
): Promise<void> {
  await withChatIdb(scope, async (db) => {
    const stores = createArtifactItemCacheStores(resolvedChatIdb(db));
    await stores.writeStore.replaceItems(artifacts);
    if (lastSyncedAt) {
      await stores.writeStore.setLastSyncedAt(lastSyncedAt);
    }
    const seeded = await stores.readStore.readRecent({ limit: 10_000 });
    if (seeded.length !== artifacts.length) {
      throw new Error("Expected artifact cache seed to be readable");
    }
  });
}

async function cachedArtifactIds(scope: TestAuthScope): Promise<string[]> {
  return await withChatIdb(scope, async (db) => {
    const artifacts = await createArtifactItemCacheStores(
      resolvedChatIdb(db),
    ).readStore.readRecent({ limit: 10_000 });
    return artifacts.map((artifact) => {
      return artifact.artifactItemId;
    });
  });
}

async function cachedArtifactsLastSyncedAt(
  scope: TestAuthScope,
): Promise<string | null> {
  return await withChatIdb(scope, async (db) => {
    return await createArtifactItemCacheStores(
      resolvedChatIdb(db),
    ).readStore.readLastSyncedAt();
  });
}

async function findComposerEditor(): Promise<HTMLElement> {
  return await waitFor(() => {
    const editor = document.querySelector(
      '.zero-composer [contenteditable="true"]',
    );
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Composer editor not found");
    }
    return editor;
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

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function menuItemByText(text: string): HTMLElement {
  const menuItem = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!menuItem) {
    throw new Error(`${text} menu item not found`);
  }
  return menuItem;
}

function focusedArtifactIndex(): string | null {
  return (
    document.activeElement?.closest<HTMLElement>("[data-artifact-index]")
      ?.dataset.artifactIndex ?? null
  );
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
    expect(screen.getByText("hosted site")).toBeInTheDocument();
    expect(screen.queryByText(/Jan 15/u)).not.toBeInTheDocument();
    expect(screen.getByTitle("launch-plan.html preview")).toHaveStyle({
      height: "800px",
      width: "1280px",
    });
  });

  it("shows the full artifact name when hovering its truncated title", async () => {
    const user = userEvent.setup();
    setupTeam();
    const scope = testAuthScope("filename-tooltip");
    const filename =
      "zero-template-picker-ui-7-final-production-hosted-site.html";
    mockArtifacts([createArtifact({ filename })]);

    setupArtifactsPage({ scope });

    const title = await screen.findByRole("heading", { name: filename });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.hover(title);

    await expect(screen.findByRole("tooltip")).resolves.toHaveTextContent(
      filename,
    );
  });

  it("provides visible focus feedback for the agent filter", async () => {
    setupTeam();
    const scope = testAuthScope("agent-filter-focus");
    mockArtifacts([]);

    setupArtifactsPage({ scope });

    const agentFilter = await screen.findByLabelText("Agent filter");
    expect(agentFilter).toHaveClass(
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
      "focus-visible:ring-offset-2",
    );
  });

  it("renders unified 16:10 previews above card metadata while preserving the HTML fallback", async () => {
    setupTeam();
    const scope = testAuthScope("preview-image");
    const previewImageUrl =
      "https://cdn.vm7.io/artifacts/user/artifact-row/preview-deploy.webp";
    const imageUrl = "https://artifacts.example.com/full-image.png";
    mockArtifacts([
      createArtifact({
        artifactItemId: "static-run:file-1",
        runId: "static-run",
        filename: "static-preview.html",
        previewImageUrl,
      }),
      createArtifact({
        artifactItemId: "image-run:file-1",
        runId: "image-run",
        filename: "full-image.png",
        contentType: "image/png",
        url: imageUrl,
        artifactKind: undefined,
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
    await screen.findByText("full-image.png");
    await screen.findByText("fallback-preview.html");
    const staticCard = buttonByLabel("Preview static-preview.html");
    const staticPreview = within(staticCard).getByTestId(
      "artifact-card-preview",
    );
    const staticDetails = within(staticCard).getByTestId(
      "artifact-card-details",
    );
    expect(staticCard).toHaveClass("flex", "flex-col");
    expect(staticCard).not.toHaveClass("aspect-square");
    expect(staticPreview).toHaveClass(
      "aspect-[16/10]",
      "w-full",
      "shrink-0",
      "overflow-hidden",
    );
    expect(staticPreview.nextElementSibling).toBe(staticDetails);
    expect(staticDetails).not.toHaveClass("absolute");
    expect(staticDetails).toHaveClass("h-16", "shrink-0");
    expect(
      within(staticDetails).getByRole("heading", {
        name: "static-preview.html",
      }),
    ).toBeInTheDocument();
    const htmlPreviewImages = Array.from(
      document.querySelectorAll<HTMLImageElement>(
        `img[src="${previewImageUrl}"]`,
      ),
    );
    expect(htmlPreviewImages).toHaveLength(1);
    expect(htmlPreviewImages[0]).toHaveClass(
      "h-full",
      "w-full",
      "object-cover",
    );
    const artifactImages = Array.from(
      document.querySelectorAll<HTMLImageElement>(`img[src="${imageUrl}"]`),
    );
    expect(artifactImages).toHaveLength(1);
    expect(artifactImages[0]).toHaveClass("h-full", "w-full", "object-cover");
    expect(screen.queryByTitle("static-preview.html preview")).toBeNull();
    expect(screen.getByTitle("fallback-preview.html preview")).toHaveAttribute(
      "src",
      "https://artifacts.example.com/fallback-preview.html",
    );
  });

  it("keeps card widths fluid without squeezing in a third column", async () => {
    setupTeam();
    const scope = testAuthScope("fluid-grid-width");
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "artifacts-virtual-grid" ? 700 : 0;
      },
    );
    mockArtifacts([
      createArtifact({
        artifactItemId: "fluid-grid-1:file-1",
        runId: "fluid-grid-1",
        filename: "fluid-grid-1.html",
      }),
      createArtifact({
        artifactItemId: "fluid-grid-2:file-1",
        runId: "fluid-grid-2",
        filename: "fluid-grid-2.html",
      }),
      createArtifact({
        artifactItemId: "fluid-grid-3:file-1",
        runId: "fluid-grid-3",
        filename: "fluid-grid-3.html",
      }),
    ]);

    setupArtifactsPage({ scope });

    await screen.findByText("fluid-grid-1.html");
    await waitFor(() => {
      expect(screen.getByTestId("artifacts-virtual-grid-items")).toHaveStyle({
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      });
      expect(screen.getByTestId("artifacts-virtual-grid")).toHaveStyle({
        height: "571.5px",
      });
    });
  });

  it("loads CDN image cards as thumbnails while preserving original previews", async () => {
    setupTeam();
    const scope = testAuthScope("image-thumbnail");
    const cdnImageUrl =
      "https://cdn.vm7.io/artifacts/user/image-run/generated.png";
    const thumbnailUrl =
      "https://cdn.vm7.io/cdn-cgi/image/width=640,height=400,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/user/image-run/generated.png";
    const externalImageUrl =
      "https://images.example.com/artifacts/external-image.png";
    const unsupportedCdnImageUrl =
      "https://cdn.vm7.io/artifacts/user/image-run/legacy.bmp";
    mockArtifacts([
      createArtifact({
        artifactItemId: "image-run:file-1",
        runId: "image-run",
        fileId: "image-file",
        filename: "generated.png",
        contentType: "image/png",
        url: cdnImageUrl,
        artifactKind: undefined,
      }),
      createArtifact({
        artifactItemId: "external-image-run:file-1",
        runId: "external-image-run",
        fileId: "external-image-file",
        filename: "external-image.png",
        contentType: "image/png",
        url: externalImageUrl,
        artifactKind: undefined,
      }),
      createArtifact({
        artifactItemId: "unsupported-image-run:file-1",
        runId: "unsupported-image-run",
        fileId: "unsupported-image-file",
        filename: "legacy.bmp",
        contentType: "image/bmp",
        url: unsupportedCdnImageUrl,
        artifactKind: undefined,
      }),
    ]);

    setupArtifactsPage({ scope });

    await screen.findByText("generated.png");
    await screen.findByText("external-image.png");
    await screen.findByText("legacy.bmp");
    const cardImageUrls = Array.from(
      document.querySelectorAll("article img"),
      (image) => {
        return image.getAttribute("src");
      },
    );
    expect(cardImageUrls).toStrictEqual(
      expect.arrayContaining([
        thumbnailUrl,
        externalImageUrl,
        unsupportedCdnImageUrl,
      ]),
    );
    expect(cardImageUrls).not.toContain(cdnImageUrl);

    click(buttonByLabel("Preview generated.png"));
    await expect(
      screen.findByRole("dialog", { name: "generated.png preview" }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      cdnImageUrl,
    );

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    click(buttonByLabel("More actions for generated.png"));
    expect(
      screen.getByLabelText("Open preview for generated.png"),
    ).toHaveAttribute("href", cdnImageUrl);
  });

  it.each(["application/zip", "application/x-zip-compressed"])(
    "downloads %s artifacts from the actions menu",
    async (contentType) => {
      setupTeam();
      const scope = testAuthScope("download-zip");
      const artifact = createArtifact({
        filename: "launch-assets.zip",
        contentType,
        url: "https://artifacts.example.com/launch-assets.zip",
        artifactKind: undefined,
      });
      const downloads = context.mocks.browser.blobDownload();
      context.mocks.http.get(artifact.url, () => {
        return new Response("zip contents", {
          headers: { "Content-Type": contentType },
        });
      });
      mockArtifacts([artifact]);

      setupArtifactsPage({ scope });

      await screen.findByText("launch-assets.zip");
      click(buttonByLabel("More actions for launch-assets.zip"));
      const downloadItem = screen
        .getByText("Download")
        .closest("[role=menuitem]");
      expect(downloadItem).not.toBeNull();
      expect(
        downloadItem?.querySelector(".tabler-icon-download"),
      ).not.toBeNull();
      expect(screen.queryByText("Open in new tab")).not.toBeInTheDocument();

      click(screen.getByText("Download"));
      await waitFor(() => {
        expect(downloads.downloads).toHaveLength(1);
      });
      expect(downloads.downloads[0]?.filename).toBe("launch-assets.zip");
    },
  );

  it("opens previewable artifacts in the lightbox without split view", async () => {
    setupTeam();
    const scope = testAuthScope("preview-lightbox");
    mockArtifacts([
      createArtifact({
        artifactItemId: "image-run:file-1",
        runId: "image-run",
        fileId: "image-file",
        filename: "launch-image.png",
        contentType: "image/png",
        size: 1024,
        artifactKind: undefined,
      }),
      createArtifact({
        artifactItemId: "site-run:file-1",
        runId: "site-run",
        fileId: "site-file",
        filename: "launch-site.html",
        url: "https://artifacts.example.com/launch-site.html",
        size: 9216,
      }),
      createArtifact({
        artifactItemId: "video-run:file-1",
        runId: "video-run",
        fileId: "video-file",
        filename: "launch-video.mp4",
        contentType: "video/mp4",
        size: 2048,
        artifactKind: undefined,
      }),
      createArtifact({
        artifactItemId: "presentation-run:file-1",
        runId: "presentation-run",
        fileId: "presentation-file",
        filename: "launch-slides.html",
        contentType: "text/html",
        size: 4096,
        artifactKind: "presentation-html",
      }),
      createArtifact({
        artifactItemId: "audio-run:file-1",
        runId: "audio-run",
        fileId: "audio-file",
        filename: "launch-audio.mp3",
        contentType: "audio/mpeg",
        size: 3072,
        url: "https://artifacts.example.com/launch-audio.mp3",
        artifactKind: undefined,
      }),
      createArtifact({
        artifactItemId: "document-run:file-1",
        runId: "document-run",
        fileId: "document-file",
        filename: "launch-document.pdf",
        contentType: "application/pdf",
        size: 5120,
        url: "https://artifacts.example.com/launch-document.pdf",
        artifactKind: undefined,
      }),
    ]);

    setupArtifactsPage({
      scope,
      htmlArtifactCommentEditingEnabled: true,
      imageEditingEnabled: true,
    });

    await screen.findByText("launch-image.png");
    await screen.findByText("launch-video.mp4");
    expect(screen.getByLabelText("Presentation artifact")).toBeInTheDocument();
    expect(screen.getByLabelText("HTML artifact")).toBeInTheDocument();
    expect(screen.getByLabelText("Image artifact")).toBeInTheDocument();
    expect(screen.getByLabelText("Video artifact")).toBeInTheDocument();

    click(buttonByLabel("Preview launch-image.png"));
    await expect(
      screen.findByRole("dialog", { name: "launch-image.png preview" }),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByLabelText("Edit image")).toBeNull();
    expect(screen.queryByLabelText("Open in split view")).toBeNull();
    expect(screen.queryByText(/1.0 KB/u)).toBeNull();
    expect(
      screen.getByRole("img", { name: "launch-image.png" }),
    ).toBeInTheDocument();

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    click(buttonByLabel("Preview launch-site.html"));
    await expect(
      screen.findByRole("dialog", { name: "launch-site.html preview" }),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByLabelText("Edit page")).toBeNull();
    expect(screen.queryByLabelText("Open in split view")).toBeNull();
    expect(screen.queryByText(/9.0 KB/u)).toBeNull();
    expect(screen.getByTestId("artifact-dialog-body-html")).toHaveAttribute(
      "src",
      "https://artifacts.example.com/launch-site.html",
    );

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    click(buttonByLabel("Preview launch-slides.html"));
    await expect(
      screen.findByRole("dialog", { name: "launch-slides.html preview" }),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByLabelText("Edit presentation")).toBeNull();
    expect(screen.queryByLabelText("Open in split view")).toBeNull();

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    click(buttonByLabel("Preview launch-video.mp4"));
    await expect(
      screen.findByRole("dialog", { name: "launch-video.mp4 preview" }),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByLabelText("Open in split view")).toBeNull();
    expect(
      screen.getByLabelText("Video preview for launch-video.mp4"),
    ).toBeInTheDocument();

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    click(buttonByLabel("Preview launch-audio.mp3"));
    await expect(
      screen.findByRole("dialog", { name: "launch-audio.mp3 preview" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByLabelText("Audio preview for launch-audio.mp3"),
    ).toBeInTheDocument();

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    click(buttonByLabel("Preview launch-document.pdf"));
    await expect(
      screen.findByRole("dialog", { name: "launch-document.pdf preview" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen
        .getByTestId("artifact-dialog-document-frame")
        .querySelector("iframe"),
    ).toHaveAttribute(
      "src",
      "https://artifacts.example.com/launch-document.pdf#navpanes=0",
    );

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("renders video poster images without a play affordance while preserving the video fallback", async () => {
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
    expect(posterImages[0]).toHaveClass("object-cover");
    expect(
      posterImages[0]?.closest('[data-testid="artifact-card-preview"]'),
    ).toHaveClass("aspect-[16/10]");
    expect(
      document.querySelector(".tabler-icon-player-play-filled"),
    ).not.toBeInTheDocument();
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
    click(
      await waitFor(() => {
        return menuItemByText("Research Agent");
      }),
    );
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

  it("shows interaction feedback on artifact card actions", async () => {
    setupTeam();
    const scope = testAuthScope("card-action-feedback");
    mockArtifacts([createArtifact()]);

    setupArtifactsPage({ scope });

    await screen.findByText("launch-plan.html");
    expect(buttonByLabel("More actions for launch-plan.html")).toHaveClass(
      "hover:bg-muted/60",
      "active:bg-muted",
      "data-[state=open]:bg-muted",
    );
  });

  it("preserves a saved draft and references a hosted artifact by URL", async () => {
    setupTeam();
    const scope = testAuthScope("ask-artifact");
    const artifact = createArtifact();
    mockArtifacts([artifact]);
    context.mocks.api(zeroAgentDraftContract.get, ({ respond }) => {
      return respond(200, {
        draftContent: "Keep this draft",
        draftAttachments: null,
      });
    });

    setupArtifactsPage({ scope });

    await screen.findByText("launch-plan.html");
    click(buttonByLabel("More actions for launch-plan.html"));
    click(screen.getByText("Ask about this"));

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${ZERO_AGENT_ID}/chat`);
    });
    const editor = await findComposerEditor();
    expect(editor).toHaveTextContent("Keep this draft");
    expect(editor).toHaveTextContent(artifact.url);
    expect(screen.queryByLabelText(`Remove ${artifact.filename}`)).toBeNull();
  });

  it("keeps same-named draft attachments with different stable identities", async () => {
    setupTeam();
    const scope = testAuthScope("ask-artifact-identity");
    const artifact = createArtifact({
      artifactItemId: "selected-run:selected-file",
      runId: "selected-run",
      fileId: "selected-file",
      filename: "same-name.png",
      contentType: "image/png",
      size: 1024,
      url: "https://artifacts.example.com/selected-file.png",
      artifactKind: undefined,
    });
    mockArtifacts([artifact]);
    context.mocks.api(zeroAgentDraftContract.get, ({ respond }) => {
      return respond(200, {
        draftContent: "Keep both files",
        draftAttachments: [
          {
            id: "existing-file",
            filename: "same-name.png",
            contentType: "image/png",
            size: 1024,
            url: "https://artifacts.example.com/existing-file.png",
          },
        ],
      });
    });
    const draftPatches: {
      readonly draftAttachments?:
        | readonly {
            readonly id: string;
            readonly url: string;
          }[]
        | null;
    }[] = [];
    context.mocks.api(zeroAgentDraftContract.patch, ({ body, respond }) => {
      draftPatches.push(body);
      return respond(204);
    });

    setupArtifactsPage({ scope });

    await screen.findByText("same-name.png");
    click(buttonByLabel("More actions for same-name.png"));
    click(screen.getByText("Ask about this"));

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${ZERO_AGENT_ID}/chat`);
    });
    const editor = await findComposerEditor();
    expect(editor).toHaveTextContent("Keep both files");
    expect(screen.getAllByLabelText("Remove same-name.png")).toHaveLength(2);

    await fill(editor, "Updated draft");
    await waitFor(() => {
      expect(draftPatches).toContainEqual({
        draftContent: "Updated draft",
        draftStructuredPrompt: null,
        draftAttachments: [
          {
            id: "existing-file",
            filename: "same-name.png",
            contentType: "image/png",
            size: 1024,
            url: "https://artifacts.example.com/existing-file.png",
          },
          {
            id: artifact.fileId,
            filename: artifact.filename,
            contentType: artifact.contentType,
            size: artifact.size,
            url: artifact.url,
          },
        ],
      });
    });
  });

  it("navigates to the original conversation", async () => {
    setupTeam();
    const scope = testAuthScope("navigate");
    mockArtifacts([createArtifact()]);

    setupArtifactsPage({ scope });

    await screen.findByText("launch-plan.html");
    expect(
      screen.queryByLabelText("Open source chat for launch-plan.html"),
    ).toBeNull();
    click(buttonByLabel("More actions for launch-plan.html"));
    click(screen.getByText("View original chat"));

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

  it("shows an error when an incremental response needs a timed-out cache", async () => {
    setupTeam();
    const scope = testAuthScope("incremental-cache-timeout");
    const lastSyncedAt = "2026-01-02T00:00:00.000Z";
    await seedCachedArtifacts(
      scope,
      [
        createArtifact({
          artifactItemId: "cached-timeout-run:file-1",
          runId: "cached-timeout-run",
          filename: "cached-timeout.html",
          createdAt: lastSyncedAt,
        }),
      ],
      lastSyncedAt,
    );
    const blockedRead = artifactIdbMock.blockArtifactCursorContinuation();
    let requestedUpdatedAfter: string | undefined;
    context.mocks.api(artifactsContract.list, ({ query, respond }) => {
      requestedUpdatedAfter = query.updatedAfter;
      return respond(200, {
        artifacts: [],
        truncated: false,
        nextCursor: null,
        syncUntil: "2026-01-03T00:00:00.000Z",
      });
    });

    setupArtifactsPage({ scope });

    await blockedRead.started;
    try {
      await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
        "Could not load artifacts",
      );
      expect(screen.queryByText("No artifacts found")).not.toBeInTheDocument();
      expect(requestedUpdatedAfter).toBe(lastSyncedAt);
    } finally {
      blockedRead.release();
    }
  });

  it("refetches a full snapshot when the background cache merge times out", async () => {
    setupTeam();
    const scope = testAuthScope("incremental-full-cache-timeout");
    const lastSyncedAt = "2026-01-03T00:00:00.000Z";
    const cachedArtifacts = Array.from({ length: 61 }, (_, index) => {
      const sequence = String(index).padStart(2, "0");
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      return createArtifact({
        artifactItemId: `cached-${sequence}:file-1`,
        runId: `cached-${sequence}`,
        filename: `cached-${sequence}.html`,
        createdAt,
        updatedAt: createdAt,
      });
    });
    const changedArtifact = createArtifact({
      artifactItemId: "changed:file-1",
      runId: "changed",
      filename: "changed.html",
      createdAt: "2026-01-04T00:00:00.000Z",
      updatedAt: "2026-01-04T00:00:00.000Z",
    });
    await seedCachedArtifacts(scope, cachedArtifacts, lastSyncedAt);
    // The first-paint read stops at 60 without continuing. Only the background
    // full-cache read reaches this gate while requesting the 61st item.
    const blockedRead = artifactIdbMock.blockArtifactCursorContinuation(60);
    let fullSnapshotRequests = 0;
    context.mocks.api(artifactsContract.list, ({ query, respond }) => {
      if (query.updatedAfter) {
        return respond(200, {
          artifacts: [changedArtifact],
          truncated: false,
          nextCursor: null,
          syncUntil: "2026-01-05T00:00:00.000Z",
        });
      }
      fullSnapshotRequests += 1;
      return respond(200, {
        artifacts: [changedArtifact, ...cachedArtifacts],
        truncated: false,
        nextCursor: null,
        syncUntil: "2026-01-05T00:00:00.000Z",
      });
    });

    setupArtifactsPage({ scope });

    await blockedRead.started;
    try {
      await fill(
        screen.getByPlaceholderText("Search artifacts..."),
        "cached-00.html",
      );
      await expect(
        screen.findByText("cached-00.html"),
      ).resolves.toBeInTheDocument();
      expect(fullSnapshotRequests).toBe(1);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      blockedRead.release();
    }
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
    const cached = await withChatIdb(scope, async (db) => {
      return await createArtifactItemCacheStores(
        resolvedChatIdb(db),
      ).readStore.readRecent({ limit: 10_000 });
    });
    expect(cached).toStrictEqual([artifact]);
  });

  it("renders remote artifacts before replacing the IndexedDB cache", async () => {
    setupTeam();
    const scope = testAuthScope("remote-cache-background-write");
    const artifact = createArtifact({
      artifactItemId: "background-write-run:file-1",
      runId: "background-write-run",
      filename: "background-write.html",
    });
    const replacement = artifactIdbMock.blockArtifactReplacement();
    mockArtifacts([artifact]);

    setupArtifactsPage({ scope });

    await replacement.started;
    try {
      expect(screen.getByText("background-write.html")).toBeInTheDocument();
    } finally {
      replacement.release();
    }
    await waitFor(async () => {
      await expect(cachedArtifactIds(scope)).resolves.toStrictEqual([
        artifact.artifactItemId,
      ]);
    });
  });

  it("cancels an obsolete cache replacement when metadata refreshes", async () => {
    setupTeam();
    context.mocks.data.connectors([googleDriveConnector()]);
    const scope = testAuthScope("obsolete-cache-replacement");
    const obsoleteArtifact = createArtifact({
      artifactItemId: "obsolete-sync:file-1",
      runId: "obsolete-sync",
      filename: "obsolete-sync.html",
    });
    const currentArtifact = createArtifact({
      artifactItemId: "current-sync:file-1",
      runId: "current-sync",
      filename: "current-sync.html",
    });
    const obsoleteSyncUntil = "2026-01-02T00:00:00.000Z";
    const currentSyncUntil = "2026-01-03T00:00:00.000Z";
    let serveCurrentArtifacts = false;
    let listCalls = 0;
    context.mocks.api(artifactsContract.list, ({ respond }) => {
      listCalls += 1;
      return respond(200, {
        artifacts: [serveCurrentArtifacts ? currentArtifact : obsoleteArtifact],
        truncated: false,
        nextCursor: null,
        syncUntil: serveCurrentArtifacts ? currentSyncUntil : obsoleteSyncUntil,
      });
    });
    context.mocks.api(
      chatThreadArtifactsContract.syncGoogleDrive,
      ({ respond }) => {
        serveCurrentArtifacts = true;
        return respond(200, {
          id: "drive-current-sync",
          name: currentArtifact.filename,
          webViewLink: "https://drive.test/current-sync",
        });
      },
    );
    const replacement = artifactIdbMock.blockArtifactReplacement();

    setupArtifactsPage({ scope });

    await replacement.started;
    try {
      expect(screen.getByText("obsolete-sync.html")).toBeInTheDocument();
      click(buttonByLabel("Preview obsolete-sync.html"));
      await expect(
        screen.findByRole("dialog", { name: "obsolete-sync.html preview" }),
      ).resolves.toBeInTheDocument();
      click(buttonByLabel("Download options"));
      await waitFor(() => {
        expect(menuItemByText("Upload to Google Drive")).toBeInTheDocument();
      });
      click(menuItemByText("Upload to Google Drive"));
      await expect(
        screen.findByText("current-sync.html"),
      ).resolves.toBeInTheDocument();
      await expect(cachedArtifactIds(scope)).resolves.toStrictEqual([
        currentArtifact.artifactItemId,
      ]);
      await expect(cachedArtifactsLastSyncedAt(scope)).resolves.toBe(
        currentSyncUntil,
      );
    } finally {
      replacement.release();
    }

    await replacement.completed;
    await waitFor(async () => {
      await expect(cachedArtifactIds(scope)).resolves.toStrictEqual([
        currentArtifact.artifactItemId,
      ]);
      await expect(cachedArtifactsLastSyncedAt(scope)).resolves.toBe(
        currentSyncUntil,
      );
    });
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });

  it("renders the cache immediately when returning while the remote refresh is pending", async () => {
    setupTeam();
    const scope = testAuthScope("return-to-cache");
    const artifact = createArtifact({
      artifactItemId: "return-cache-run:file-1",
      runId: "return-cache-run",
      filename: "return-cache-summary.html",
    });
    mockArtifacts([artifact]);

    setupArtifactsPage({ scope });

    await screen.findByText("return-cache-summary.html");
    await waitFor(async () => {
      await expect(cachedArtifactIds(scope)).resolves.toStrictEqual([
        artifact.artifactItemId,
      ]);
    });

    context.mocks.api(artifactsContract.list, ({ never }) => {
      return never();
    });
    click(linkByText("Agents"));
    await screen.findByRole("heading", { level: 1, name: /agents/i });
    click(linkByText("Artifacts"));

    await expect(
      screen.findByText("return-cache-summary.html"),
    ).resolves.toBeInTheDocument();
  });

  it("normalizes older remote artifacts without a size", async () => {
    setupTeam();
    const scope = testAuthScope("remote-size-default");
    const { size, ...legacyArtifact } = createArtifact({
      artifactItemId: "legacy-remote-run:file-1",
      runId: "legacy-remote-run",
      filename: "legacy-remote.html",
    });
    expect(size).toBeGreaterThan(0);
    context.mocks.api(artifactsContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [legacyArtifact as ArtifactItem],
        truncated: false,
        nextCursor: null,
      });
    });

    setupArtifactsPage({ scope });

    await screen.findByText("legacy-remote.html");
    await waitFor(async () => {
      const cached = await withChatIdb(scope, async (db) => {
        return await createArtifactItemCacheStores(
          resolvedChatIdb(db),
        ).readStore.readRecent({ limit: 10_000 });
      });
      expect(cached).toHaveLength(1);
      expect(cached[0]?.size).toBe(0);
    });
  });

  it("merges remote changes into the cached artifact set", async () => {
    setupTeam();
    const scope = testAuthScope("remote-cache-replace");
    const staleArtifact = createArtifact({
      artifactItemId: "stale-run:file-1",
      runId: "stale-run",
      filename: "stale-summary.html",
      url: "https://artifacts.example.com/stale-summary.html",
      createdAt: "2026-01-02T00:00:00Z",
    });
    const remoteArtifact = createArtifact({
      artifactItemId: "fresh-run:file-1",
      runId: "fresh-run",
      filename: "fresh-summary.html",
      url: "https://artifacts.example.com/fresh-summary.html",
      createdAt: "2026-01-03T00:00:00Z",
    });
    await seedCachedArtifacts(scope, [staleArtifact]);
    let requestedUpdatedAfter: string | undefined;
    context.mocks.api(artifactsContract.list, ({ query, respond }) => {
      requestedUpdatedAfter = query.updatedAfter;
      return respond(200, {
        artifacts: [remoteArtifact],
        truncated: false,
        nextCursor: null,
        syncUntil: "2026-01-04T00:00:00.000Z",
      });
    });

    setupArtifactsPage({ scope });

    await screen.findByText("fresh-summary.html");
    expect(screen.getByText("stale-summary.html")).toBeInTheDocument();
    expect(requestedUpdatedAfter).toBe(staleArtifact.createdAt);
    await waitFor(async () => {
      await expect(cachedArtifactIds(scope)).resolves.toStrictEqual([
        remoteArtifact.artifactItemId,
        staleArtifact.artifactItemId,
      ]);
    });
    await expect(
      withChatIdb(scope, async (db) => {
        return await createArtifactItemCacheStores(
          resolvedChatIdb(db),
        ).readStore.readLastSyncedAt();
      }),
    ).resolves.toBe("2026-01-04T00:00:00.000Z");
  });

  it("keeps the most recently updated artifact for a shared URL", async () => {
    setupTeam();
    const scope = testAuthScope("shared-url-winner");
    const sharedUrl = "https://artifacts.example.com/shared.html";
    const newestCreated = createArtifact({
      artifactItemId: "newest-created:file-1",
      threadId: "thread-newest-created",
      runId: "newest-created",
      filename: "newest-created.html",
      url: sharedUrl,
      createdAt: "2026-01-03T00:00:00Z",
      updatedAt: "2026-01-03T00:00:00Z",
    });
    const newestUpdated = createArtifact({
      artifactItemId: "newest-updated:file-1",
      threadId: "thread-newest-updated",
      runId: "newest-updated",
      filename: "newest-updated.html",
      url: sharedUrl,
      createdAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-04T00:00:00Z",
    });
    mockArtifacts([newestCreated, newestUpdated]);

    setupArtifactsPage({ scope });

    await screen.findByText("newest-updated.html");
    expect(screen.queryByText("newest-created.html")).not.toBeInTheDocument();
    await waitFor(async () => {
      await expect(cachedArtifactIds(scope)).resolves.toStrictEqual([
        newestUpdated.artifactItemId,
      ]);
    });
  });

  it("replaces the cache when the server omits incremental sync metadata", async () => {
    setupTeam();
    const scope = testAuthScope("remote-legacy-server");
    const cachedArtifact = createArtifact({
      artifactItemId: "legacy-cached:file-1",
      runId: "legacy-cached",
      filename: "legacy-cached.html",
      url: "https://artifacts.example.com/legacy-cached.html",
      createdAt: "2026-01-02T00:00:00Z",
    });
    const remoteArtifact = createArtifact({
      artifactItemId: "legacy-remote:file-1",
      runId: "legacy-remote",
      filename: "legacy-remote.html",
      url: "https://artifacts.example.com/legacy-remote.html",
      createdAt: "2026-01-03T00:00:00Z",
    });
    await seedCachedArtifacts(scope, [cachedArtifact]);
    mockArtifacts([remoteArtifact]);

    setupArtifactsPage({ scope });

    await screen.findByText("legacy-remote.html");
    expect(screen.queryByText("legacy-cached.html")).not.toBeInTheDocument();
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

  it("renders the first remote page while the next cursor is pending", async () => {
    setupTeam();
    const scope = testAuthScope("paged-progressive");
    context.mocks.api(artifactsContract.list, ({ query, respond, never }) => {
      if (query.cursor) {
        return never();
      }
      return respond(200, {
        artifacts: [
          createArtifact({
            artifactItemId: "progressive-page-one:file-1",
            runId: "progressive-page-one",
            filename: "progressive-page-one.html",
          }),
        ],
        truncated: false,
        nextCursor: "cursor-page-2",
      });
    });

    setupArtifactsPage({ scope });

    await expect(
      screen.findByText("progressive-page-one.html"),
    ).resolves.toBeInTheDocument();
  });

  it("virtualizes a large set and loads more near the scroll boundary", async () => {
    setupTeam();
    const scope = testAuthScope("windowed");
    const many = Array.from({ length: 180 }, (_, index) => {
      const label = String(index).padStart(3, "0");
      return createArtifact({
        artifactItemId: `windowed-${label}:file`,
        runId: `windowed-${label}`,
        filename: `windowed-${label}.html`,
        createdAt: new Date(Date.UTC(2026, 0, 2, 0, -index)).toISOString(),
      });
    });
    mockArtifacts(many);

    setupArtifactsPage({ scope });

    await screen.findByText("windowed-000.html");
    expect(screen.queryByText("Load more")).not.toBeInTheDocument();
    expect(document.querySelectorAll("article").length).toBeLessThanOrEqual(24);

    const scrollViewport = screen.getByRole("main");
    const setScrollMetrics = mockScrollViewport(scrollViewport, {
      clientHeight: 800,
      scrollHeight: 5173,
      scrollTop: 4373,
    });
    fireEvent.scroll(scrollViewport);

    await screen.findByText("windowed-064.html");
    expect(screen.queryByText("windowed-000.html")).not.toBeInTheDocument();
    expect(document.querySelectorAll("article").length).toBeLessThanOrEqual(24);

    setScrollMetrics({ scrollHeight: 10_358, scrollTop: 9558 });
    fireEvent.scroll(scrollViewport);

    await screen.findByText("windowed-119.html");
    expect(screen.queryByText("windowed-064.html")).not.toBeInTheDocument();
    expect(document.querySelectorAll("article").length).toBeLessThanOrEqual(24);

    setScrollMetrics({ scrollHeight: 15_543, scrollTop: 14_743 });
    fireEvent.scroll(scrollViewport);

    await screen.findByText("windowed-179.html");
    expect(screen.queryByText("windowed-119.html")).not.toBeInTheDocument();
    expect(document.querySelectorAll("article").length).toBeLessThanOrEqual(24);
  });

  it("continues keyboard navigation through virtualized artifacts", async () => {
    setupTeam();
    const scope = testAuthScope("keyboard-windowed");
    const many = Array.from({ length: 120 }, (_, index) => {
      const label = String(index).padStart(3, "0");
      return createArtifact({
        artifactItemId: `keyboard-windowed-${label}:file`,
        runId: `keyboard-windowed-${label}`,
        filename: `keyboard-windowed-${label}.html`,
        createdAt: new Date(Date.UTC(2026, 0, 2, 0, -index)).toISOString(),
      });
    });
    mockArtifacts(many);

    setupArtifactsPage({ scope });

    await screen.findByText("keyboard-windowed-000.html");
    const scrollViewport = screen.getByRole("main");
    const setScrollMetrics = mockScrollViewport(scrollViewport, {
      clientHeight: 800,
      scrollHeight: 6068,
      scrollTop: 0,
    });

    fireEvent.focus(buttonByText("Continue browsing artifacts"));

    await waitFor(() => {
      expect(focusedArtifactIndex()).toBe("18");
    });
    await screen.findByText("keyboard-windowed-018.html");

    setScrollMetrics({ scrollHeight: 20_000, scrollTop: 4560 });
    fireEvent.scroll(scrollViewport);
    await screen.findByText("keyboard-windowed-059.html");

    fireEvent.focus(buttonByText("Continue browsing artifacts"));

    await waitFor(() => {
      expect(focusedArtifactIndex()).toBe("60");
    });
    await screen.findByText("keyboard-windowed-060.html");

    const firstMountedArtifact = document.querySelector<HTMLElement>(
      "article[data-artifact-index]",
    );
    if (!firstMountedArtifact?.dataset.artifactIndex) {
      throw new Error("First mounted artifact not found");
    }
    const firstMountedIndex = Number(
      firstMountedArtifact.dataset.artifactIndex,
    );
    expect(firstMountedIndex).toBeGreaterThan(0);

    firstMountedArtifact.focus();
    fireEvent.keyDown(firstMountedArtifact, { key: "Tab", shiftKey: true });

    await waitFor(() => {
      expect(focusedArtifactIndex()).toBe(String(firstMountedIndex - 1));
    });
  });
});
