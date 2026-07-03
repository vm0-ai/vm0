import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { zeroRelationshipCommand } from "../index";

const RELATIONSHIP = {
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
  items: [
    {
      id: "00000000-0000-4000-8000-000000000103",
      kind: "open_loop",
      text: "Send the security data-retention answer.",
      confidence: 90,
      lastSeenAt: "2026-07-02T12:00:00.000Z",
      sources: [],
    },
  ],
  recentInteractions: [],
} as const;

describe("zero relationship command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  it("resolves a relationship by email", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/zero/relationships/resolve",
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-zero-token",
          );
          const url = new URL(request.url);
          expect(url.searchParams.get("email")).toBe("alice@acme.com");
          return HttpResponse.json({ relationship: RELATIONSHIP });
        },
      ),
    );

    await zeroRelationshipCommand.parseAsync([
      "node",
      "cli",
      "get",
      "--email",
      "alice@acme.com",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Relationship loaded");
    expect(output).toContain("Alice Lee");
    expect(output).toContain("Send the security data-retention answer.");
  });

  it("searches relationship memory and can print JSON", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/zero/relationships/search",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("q")).toBe("security review");
          return HttpResponse.json({ relationships: [RELATIONSHIP] });
        },
      ),
    );

    await zeroRelationshipCommand.parseAsync([
      "node",
      "cli",
      "search",
      "security review",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      { relationships: [RELATIONSHIP] },
    );
  });

  it("requires exactly one get lookup", async () => {
    await expect(async () => {
      await zeroRelationshipCommand.parseAsync(["node", "cli", "get"]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Choose exactly one lookup");
    expect(stderr).toContain("Pass one of --id, --email, or --domain.");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("only exposes read-only subcommands", () => {
    const subcommands = zeroRelationshipCommand.commands.map((command) => {
      return command.name();
    });
    expect(subcommands).toStrictEqual(["get", "search"]);
  });
});
