/**
 * Tests for zero generate website command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): none for the source-selection path
 * - Real (internal): prompt parsing and authoring packet generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import { generateCommand } from "../index";

describe("zero generate website command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("should print source selection instructions for website", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "observability launch site",
      "--template",
      "launch",
      "--title",
      "Clearpath",
      "--audience",
      "small engineering teams",
      "--site",
      "clearpath-demo",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("# Zero generate website");
    expect(stdout).toContain("federated generation source-selection packet");
    expect(stdout).toContain("## Stage 1: Resource Selection");
    expect(stdout).toContain("## Candidate Registry Slice");
    expect(stdout).toContain("observability launch site");
    expect(stdout).toContain("template:web-prototype-taste-editorial");
    expect(stdout).toContain(
      "Write the artifact under `./generated/mockups/clearpath-demo/`.",
    );
    expect(stdout).toContain(
      "zero host ./generated/mockups/clearpath-demo --site clearpath-demo --spa",
    );
    expect(stdout).toContain("Template direction: launch");
    expect(stdout).toContain("Audience: small engineering teams");
  });

  it("should print JSON resource selection metadata when --json is provided", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "observability launch site",
      "--site",
      "clearpath-demo",
      "--json",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      type: "generation-source-selection",
      kind: "website",
      prompt: "observability launch site",
      outputDir: "./generated/mockups/clearpath-demo",
      site: "clearpath-demo",
      hostCommand:
        "zero host ./generated/mockups/clearpath-demo --site clearpath-demo --spa",
    });
    expect(parsed.selection).toEqual(
      expect.objectContaining({
        candidates: expect.objectContaining({
          skills: expect.any(Array),
          templates: expect.arrayContaining([
            expect.objectContaining({
              id: "template:web-prototype-taste-editorial",
            }),
          ]),
          designSystems: expect.any(Array),
        }),
      }),
    );
    expect(parsed.instructions).toEqual(
      expect.stringContaining("## Stage 3: Author Artifact"),
    );
  });
});
