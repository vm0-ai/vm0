import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { zeroMemoryCommand } from "../index";

const MEMORY = {
  id: "00000000-0000-4000-8000-000000000103",
  kind: "open_loop",
  text: "Send the security data-retention answer.",
  confidence: 90,
  lastSeenAt: "2026-07-02T12:00:00.000Z",
  relationship: {
    id: "00000000-0000-4000-8000-000000000101",
    entity: {
      id: "00000000-0000-4000-8000-000000000102",
      type: "person",
      displayName: "Alice Lee",
      primaryEmail: "alice@acme.com",
      domain: "acme.com",
    },
    relationshipType: "Customer champion",
    status: "active",
    summary: "Alice is waiting for the security review answer.",
    lastInteractionAt: "2026-07-02T12:00:00.000Z",
  },
  sources: [
    {
      id: "00000000-0000-4000-8000-000000000104",
      provider: "gmail",
      externalId: "gmail-message-1:open_loop:security",
      threadId: "thread-1",
      messageId: "gmail-message-1",
      quote: "Can you send the retention answer?",
      occurredAt: "2026-07-02T12:00:00.000Z",
    },
  ],
} as const;

const DOCUMENT_RESULT = {
  kind: "document_chunk",
  id: "00000000-0000-4000-8000-000000000203",
  documentId: "00000000-0000-4000-8000-000000000201",
  chunkId: "00000000-0000-4000-8000-000000000203",
  title: "Security review plan",
  text: "The security review plan covers data retention controls.",
  score: 0.91,
  provider: "github",
  sourceType: "github_issue",
  externalId: "github-source-1",
  occurredAt: "2026-07-02T12:00:00.000Z",
  contextSpace: {
    id: "00000000-0000-4000-8000-000000000202",
    type: "repo",
    key: "github:vm0-ai/vm0",
    displayName: "vm0-ai/vm0",
  },
  citation: {
    provider: "github",
    sourceId: "00000000-0000-4000-8000-000000000204",
    externalId: "github-source-1",
    title: "Security review plan",
    url: "https://github.com/vm0-ai/vm0/issues/1",
    locator: "#1",
    occurredAt: "2026-07-02T12:00:00.000Z",
  },
} as const;

const LIFECYCLE_MEMORY = {
  id: "00000000-0000-4000-8000-000000000301",
  kind: "key_fact",
  status: "active",
  text: "Use concise launch summaries.",
  confidence: 91,
  sourceCount: 0,
  lastSeenAt: "2026-07-02T12:00:00.000Z",
  createdAt: "2026-07-02T12:00:00.000Z",
  updatedAt: "2026-07-02T12:00:00.000Z",
  contextSpace: {
    id: "00000000-0000-4000-8000-000000000302",
    type: "user",
    key: "user:00000000-0000-4000-8000-000000000001",
    displayName: "User memory",
  },
  entity: {
    id: "00000000-0000-4000-8000-000000000303",
    type: "organization",
    displayName: "Direct memories",
  },
} as const;

const MEMORY_TOMBSTONE = {
  id: "00000000-0000-4000-8000-000000000401",
  targetKind: "memory",
  fingerprint: `memory:${LIFECYCLE_MEMORY.id}`,
  reason: "cleanup",
  prompt: null,
  targetId: LIFECYCLE_MEMORY.id,
  targetTitle: null,
  targetText: LIFECYCLE_MEMORY.text,
  contextSpace: LIFECYCLE_MEMORY.contextSpace,
  createdAt: "2026-07-02T12:05:00.000Z",
} as const;

const MEMORY_DOCUMENT = {
  id: "00000000-0000-4000-8000-000000000501",
  status: "active",
  title: "Security review plan",
  provider: "github",
  sourceType: "github_issue",
  externalId: "github-source-1",
  contentHash: "document-hash-1",
  occurredAt: "2026-07-02T12:00:00.000Z",
  createdAt: "2026-07-02T12:00:00.000Z",
  updatedAt: "2026-07-02T12:00:00.000Z",
  chunkCount: 2,
  contextSpace: DOCUMENT_RESULT.contextSpace,
  citationUrl: "https://github.com/vm0-ai/vm0/issues/1",
} as const;

describe("zero memory command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  it("recalls memory and can print JSON", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/zero/memory/recall",
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-zero-token",
          );
          const url = new URL(request.url);
          expect(url.searchParams.get("q")).toBe("security review");
          expect(url.searchParams.get("kind")).toBe("open_loop");
          expect(url.searchParams.get("limit")).toBe("5");
          return HttpResponse.json({
            query: "security review",
            memories: [MEMORY],
          });
        },
      ),
    );

    await zeroMemoryCommand.parseAsync([
      "node",
      "cli",
      "recall",
      "security review",
      "--kind",
      "open_loop",
      "--limit",
      "5",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      { query: "security review", memories: [MEMORY] },
    );
  });

  it("prints prompt-ready context", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/zero/memory/context",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("q")).toBe("security review");
          return HttpResponse.json({
            query: "security review",
            context:
              "Structured memory:\n\nOpen loops:\n- Send the security data-retention answer. (Alice Lee)",
            memories: [MEMORY],
          });
        },
      ),
    );

    await zeroMemoryCommand.parseAsync([
      "node",
      "cli",
      "context",
      "--query",
      "security review",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Structured memory:");
    expect(output).toContain("Send the security data-retention answer.");
  });

  it("searches document memory and can print JSON", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/zero/memory/search",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("q")).toBe("security review");
          expect(url.searchParams.get("mode")).toBe("documents");
          expect(url.searchParams.get("provider")).toBe("github");
          expect(url.searchParams.get("limit")).toBe("3");
          return HttpResponse.json({
            query: "security review",
            mode: "documents",
            results: [DOCUMENT_RESULT],
          });
        },
      ),
    );

    await zeroMemoryCommand.parseAsync([
      "node",
      "cli",
      "search",
      "security review",
      "--mode",
      "documents",
      "--provider",
      "github",
      "--limit",
      "3",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        query: "security review",
        mode: "documents",
        results: [DOCUMENT_RESULT],
      },
    );
  });

  it("lists lifecycle memory and can print JSON", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/zero/memory/memories",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("status")).toBe("archived");
          expect(url.searchParams.get("kind")).toBe("key_fact");
          expect(url.searchParams.get("limit")).toBe("2");
          return HttpResponse.json({
            memories: [LIFECYCLE_MEMORY],
            pagination: {
              page: 1,
              pageSize: 2,
              total: 1,
              totalPages: 1,
              hasMore: false,
            },
          });
        },
      ),
    );

    await zeroMemoryCommand.parseAsync([
      "node",
      "cli",
      "list",
      "--status",
      "archived",
      "--kind",
      "key_fact",
      "--limit",
      "2",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        memories: [LIFECYCLE_MEMORY],
        pagination: {
          page: 1,
          pageSize: 2,
          total: 1,
          totalPages: 1,
          hasMore: false,
        },
      },
    );
  });

  it("creates direct memory and can print JSON", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/zero/memory/memories",
        async ({ request }) => {
          await expect(request.json()).resolves.toStrictEqual({
            text: LIFECYCLE_MEMORY.text,
            kind: "key_fact",
            confidence: 91,
            entityDisplayName: "Direct memories",
          });
          return HttpResponse.json({ memory: LIFECYCLE_MEMORY });
        },
      ),
    );

    await zeroMemoryCommand.parseAsync([
      "node",
      "cli",
      "create",
      LIFECYCLE_MEMORY.text,
      "--kind",
      "key_fact",
      "--confidence",
      "91",
      "--entity",
      "Direct memories",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      { memory: LIFECYCLE_MEMORY },
    );
  });

  it("updates direct memory and creates a new version", async () => {
    server.use(
      http.patch(
        `http://localhost:3000/api/zero/memory/memories/${LIFECYCLE_MEMORY.id}`,
        async ({ request }) => {
          await expect(request.json()).resolves.toStrictEqual({
            text: "Use terse launch summaries.",
          });
          return HttpResponse.json({
            memory: {
              ...LIFECYCLE_MEMORY,
              text: "Use terse launch summaries.",
            },
          });
        },
      ),
    );

    await zeroMemoryCommand.parseAsync([
      "node",
      "cli",
      "update",
      LIFECYCLE_MEMORY.id,
      "--text",
      "Use terse launch summaries.",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        memory: {
          ...LIFECYCLE_MEMORY,
          text: "Use terse launch summaries.",
        },
      },
    );
  });

  it("forgets by prompt with confirmation and can print JSON", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/zero/memory/forget",
        async ({ request }) => {
          await expect(request.json()).resolves.toStrictEqual({
            prompt: "old launch summary",
            targetKind: "all",
            provider: "github",
            limit: 3,
            reason: "cleanup",
          });
          return HttpResponse.json({ forgotten: [MEMORY_TOMBSTONE] });
        },
      ),
    );

    await zeroMemoryCommand.parseAsync([
      "node",
      "cli",
      "forget-prompt",
      "old launch summary",
      "--provider",
      "github",
      "--limit",
      "3",
      "--reason",
      "cleanup",
      "--yes",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      { forgotten: [MEMORY_TOMBSTONE] },
    );
  });

  it("lists history, documents, and forgotten tombstones", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/zero/memory/history",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("targetKind")).toBe("memory");
          expect(url.searchParams.get("targetId")).toBe(LIFECYCLE_MEMORY.id);
          return HttpResponse.json({
            history: [
              {
                id: "00000000-0000-4000-8000-000000000601",
                targetKind: "memory",
                targetId: LIFECYCLE_MEMORY.id,
                version: 1,
                contentHash: "memory-hash-1",
                operation: "create",
                reason: "Direct memory creation",
                text: LIFECYCLE_MEMORY.text,
                title: null,
                status: "active",
                confidence: 91,
                kind: "key_fact",
                contextSpace: LIFECYCLE_MEMORY.contextSpace,
                createdAt: "2026-07-02T12:00:00.000Z",
              },
            ],
          });
        },
      ),
      http.get(
        "http://localhost:3000/api/zero/memory/documents",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("provider")).toBe("github");
          return HttpResponse.json({
            documents: [MEMORY_DOCUMENT],
            pagination: {
              page: 1,
              pageSize: 50,
              total: 1,
              totalPages: 1,
              hasMore: false,
            },
          });
        },
      ),
      http.get("http://localhost:3000/api/zero/memory/forgotten", () => {
        return HttpResponse.json({ forgotten: [MEMORY_TOMBSTONE] });
      }),
    );

    await zeroMemoryCommand.parseAsync([
      "node",
      "cli",
      "history",
      "memory",
      LIFECYCLE_MEMORY.id,
      "--json",
    ]);
    await zeroMemoryCommand.parseAsync([
      "node",
      "cli",
      "documents",
      "--provider",
      "github",
      "--json",
    ]);
    await zeroMemoryCommand.parseAsync(["node", "cli", "forgotten", "--json"]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        history: [
          {
            id: "00000000-0000-4000-8000-000000000601",
            targetKind: "memory",
            targetId: LIFECYCLE_MEMORY.id,
            version: 1,
            contentHash: "memory-hash-1",
            operation: "create",
            reason: "Direct memory creation",
            text: LIFECYCLE_MEMORY.text,
            title: null,
            status: "active",
            confidence: 91,
            kind: "key_fact",
            contextSpace: LIFECYCLE_MEMORY.contextSpace,
            createdAt: "2026-07-02T12:00:00.000Z",
          },
        ],
      },
    );
    expect(JSON.parse(String(mockConsoleLog.mock.calls[1]?.[0]))).toStrictEqual(
      {
        documents: [MEMORY_DOCUMENT],
        pagination: {
          page: 1,
          pageSize: 50,
          total: 1,
          totalPages: 1,
          hasMore: false,
        },
      },
    );
    expect(JSON.parse(String(mockConsoleLog.mock.calls[2]?.[0]))).toStrictEqual(
      { forgotten: [MEMORY_TOMBSTONE] },
    );
  });

  it("exposes lifecycle and read-only subcommands", () => {
    const subcommands = zeroMemoryCommand.commands.map((command) => {
      return command.name();
    });
    expect(subcommands).toStrictEqual([
      "list",
      "create",
      "update",
      "forget",
      "forget-prompt",
      "history",
      "documents",
      "forgotten",
      "recall",
      "search",
      "context",
    ]);
  });
});
