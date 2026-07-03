import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";

import { server } from "../../../../mocks/server";
import { zeroGoalCommand } from "../index";

const ACTIVE_GOAL = {
  objective: "ship goal workflows",
  objectiveBrief: "ship goal workflows",
  status: "active",
};

describe("zero goal command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  it("creates a goal and prints the JSON response", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/goal", async ({ request }) => {
        await expect(request.json()).resolves.toStrictEqual({
          objective: "ship goal workflows",
        });
        return HttpResponse.json(ACTIVE_GOAL, { status: 201 });
      }),
    );

    await zeroGoalCommand.parseAsync([
      "node",
      "cli",
      "create",
      "--objective",
      "ship goal workflows",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      ACTIVE_GOAL,
    );
  });

  it("edits a goal and prints the JSON response", async () => {
    const edited = {
      objective: "ship goal workflows v2",
      objectiveBrief: "ship goal workflows v2",
      status: "active",
    };
    server.use(
      http.patch("http://localhost:3000/api/zero/goal", async ({ request }) => {
        await expect(request.json()).resolves.toStrictEqual({
          objective: "ship goal workflows v2",
        });
        return HttpResponse.json(edited);
      }),
    );

    await zeroGoalCommand.parseAsync([
      "node",
      "cli",
      "edit",
      "--objective",
      "ship goal workflows v2",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      edited,
    );
  });

  it("gets the current goal", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/goal", () => {
        return HttpResponse.json(ACTIVE_GOAL);
      }),
    );

    await zeroGoalCommand.parseAsync(["node", "cli", "get"]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      ACTIVE_GOAL,
    );
  });

  it.each([
    [
      "complete",
      "/api/zero/goal/complete",
      { ...ACTIVE_GOAL, status: "complete" },
    ],
    ["block", "/api/zero/goal/block", { ...ACTIVE_GOAL, status: "blocked" }],
    ["pause", "/api/zero/goal/pause", { ...ACTIVE_GOAL, status: "paused" }],
    ["resume", "/api/zero/goal/resume", ACTIVE_GOAL],
  ] as const)(
    "runs %s and prints the JSON response",
    async (command, path, body) => {
      server.use(
        http.post(`http://localhost:3000${path}`, () => {
          return HttpResponse.json(body);
        }),
      );

      await zeroGoalCommand.parseAsync(["node", "cli", command]);

      expect(
        JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0])),
      ).toStrictEqual(body);
    },
  );

  it("clears the current goal", async () => {
    server.use(
      http.delete("http://localhost:3000/api/zero/goal", () => {
        return HttpResponse.json({ cleared: true });
      }),
    );

    await zeroGoalCommand.parseAsync(["node", "cli", "clear"]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      { cleared: true },
    );
  });
});
