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

describe("zero memory command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
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

  it("only exposes read-only subcommands", () => {
    const subcommands = zeroMemoryCommand.commands.map((command) => {
      return command.name();
    });
    expect(subcommands).toStrictEqual(["recall", "search", "context"]);
  });
});
