import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PiMemoryRecallSelection } from "./api-types";
import {
  loadPiSandboxMemoryRecall,
  resolvePiApiMemoryRecall,
} from "./memory-recall-node";
import {
  PI_MEMORY_PROMPT_UPSTREAM_COMMIT,
  PI_MEMORY_SUMMARY_MAX_BYTES,
  PI_MEMORY_SUMMARY_MAX_TOKENS,
  piMemorySummaryTokenCount,
  renderPiMemoryRecall,
  truncatePiMemorySummary,
} from "./memory-recall";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readySelection(
  content: string,
  overrides: Partial<
    Extract<PiMemoryRecallSelection, { status: "ready" }>
  > = {},
): Extract<PiMemoryRecallSelection, { status: "ready" }> {
  const bytes = Buffer.from(content, "utf8");
  return {
    status: "ready",
    memoryStorageId: "memory-storage",
    storageVersionId: "storage-version-a",
    content,
    sourceHash: sha256(bytes),
    sourceSize: bytes.byteLength,
    tokenCount: piMemorySummaryTokenCount(content),
    ...overrides,
  };
}

async function memoryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-recall-"));
  temporaryDirectories.push(root);
  return root;
}

describe("Pi memory recall compatibility", () => {
  it("pins the adapted Codex prompt and exact o200k token boundary", () => {
    expect(PI_MEMORY_PROMPT_UPSTREAM_COMMIT).toBe(
      "5adb68a49933ae446bf11935662c83dba55a0804",
    );
    const rendered = renderPiMemoryRecall("Prefer focused targeted tests.");
    expect(rendered).toContain(
      "MUST use `memories_search` and `memories_read` before saying that it is unavailable",
    );
    expect(rendered).toContain("including `extensions/ad_hoc/notes/`");
    expect(rendered).toContain(
      "Use `add_ad_hoc_note` only when the user explicitly asks you to remember, forget, or update something",
    );
    expect(rendered).toContain(
      "do not use Bash or another generic filesystem tool",
    );
    expect(rendered).toContain(
      "A successful tool result means only that the note is staged in the current sandbox",
    );
    expect(rendered).toContain(
      "Durable retention still depends on the terminal artifact checkpoint succeeding",
    );
    expect(rendered).toContain(
      "Do not claim that the update is durable, published, or persistently saved before the run completes successfully",
    );
    expect(sha256(rendered ?? "")).toBe(
      "54c661e1d38e525dabe6cab63e94ef7362b02e442448c7b39e968bbc1b045e89",
    );

    const oversized = Array.from({ length: 4000 }, (_, index) => {
      return `memory-${index}`;
    }).join(" ");
    const truncated = truncatePiMemorySummary(oversized);
    expect(truncated.truncated).toBe(true);
    expect(truncated.tokenCount).toBe(PI_MEMORY_SUMMARY_MAX_TOKENS);
    expect(piMemorySummaryTokenCount(truncated.text)).toBe(
      PI_MEMORY_SUMMARY_MAX_TOKENS,
    );
    expect(sha256(truncated.text)).toBe(
      "006aeaf2dcbd236813160e768d18708286a4d5997bbffdf8c4b957ed978491f6",
    );
  });

  it("renders identical frozen bytes for API-first and sandbox", async () => {
    const root = await memoryRoot();
    const content = "# Working memory\n\nUse the repository-native checks.";
    const selection = readySelection(content);
    await writeFile(join(root, "memory_summary.md"), content, "utf8");

    const api = resolvePiApiMemoryRecall({
      schemaVersion: 2,
      agentsFiles: [],
      skills: [],
      memoryRecall: selection,
    });
    const sandbox = await loadPiSandboxMemoryRecall(selection, root);

    expect(api.block).toBe(sandbox.block);
    expect(api.outcome).toMatchObject({
      mode: "api-first",
      status: "hit",
      parity: "frozen-match",
    });
    expect(sandbox.outcome).toMatchObject({
      mode: "sandbox",
      status: "hit",
      parity: "frozen-match",
    });
    expect(JSON.stringify(api.outcome)).not.toContain(content);
    expect(JSON.stringify(sandbox.outcome)).not.toContain(content);
    expect(
      api.block?.match(/========= MEMORY_SUMMARY BEGINS =========/gu),
    ).toHaveLength(1);
  });

  it("preserves V1 and frozen no-content as no-byte paths", async () => {
    expect(
      resolvePiApiMemoryRecall({
        schemaVersion: 1,
        agentsFiles: [],
        skills: [],
      }),
    ).toMatchObject({
      block: null,
      outcome: { status: "miss", parity: "not-applicable", reason: "v1" },
    });

    const noContent: PiMemoryRecallSelection = {
      status: "no-content",
      memoryStorageId: "memory-storage",
      storageVersionId: "storage-version-a",
    };
    await expect(
      loadPiSandboxMemoryRecall(noContent, "/path/that/must/not/be/read"),
    ).resolves.toMatchObject({
      block: null,
      outcome: {
        status: "miss",
        parity: "frozen-no-content",
        reason: "frozen-no-content",
      },
    });
  });
});

describe("sandbox Pi memory recall validation", () => {
  it("fails closed for missing, empty, symlink, and non-regular summaries", async () => {
    const root = await memoryRoot();
    const selection = readySelection("expected");

    await expect(
      loadPiSandboxMemoryRecall(selection, root),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "miss", reason: "missing" },
    });

    await writeFile(join(root, "memory_summary.md"), "", "utf8");
    await expect(
      loadPiSandboxMemoryRecall(selection, root),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "stale", reason: "size-mismatch" },
    });

    await rm(join(root, "memory_summary.md"));
    await symlink("target.md", join(root, "memory_summary.md"));
    await writeFile(join(root, "target.md"), "expected", "utf8");
    await expect(
      loadPiSandboxMemoryRecall(selection, root),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "invalid", reason: "symlink" },
    });

    await rm(join(root, "memory_summary.md"));
    await mkdir(join(root, "memory_summary.md"));
    await expect(
      loadPiSandboxMemoryRecall(selection, root),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "invalid", reason: "non-regular" },
    });
  });

  it("fails closed for invalid UTF-8, size, hash, and oversized files", async () => {
    const root = await memoryRoot();
    const path = join(root, "memory_summary.md");
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    await writeFile(path, invalidUtf8);
    await expect(
      loadPiSandboxMemoryRecall(
        readySelection("ok", {
          content: "ok",
          sourceHash: sha256(invalidUtf8),
          sourceSize: invalidUtf8.byteLength,
          tokenCount: 1,
        }),
        root,
      ),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "invalid", reason: "invalid-utf8" },
    });

    await writeFile(path, "actual", "utf8");
    await expect(
      loadPiSandboxMemoryRecall(
        readySelection("actual", { sourceSize: 5 }),
        root,
      ),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "stale", reason: "size-mismatch" },
    });
    await expect(
      loadPiSandboxMemoryRecall(
        readySelection("actual", { sourceHash: "0".repeat(64) }),
        root,
      ),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "stale", reason: "hash-mismatch" },
    });

    await writeFile(path, "x".repeat(PI_MEMORY_SUMMARY_MAX_BYTES + 1), "utf8");
    await expect(
      loadPiSandboxMemoryRecall(readySelection("expected"), root),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "invalid", reason: "oversized" },
    });
  });

  it("fails closed for token overflow and frozen token mismatch", async () => {
    const root = await memoryRoot();
    const path = join(root, "memory_summary.md");
    const oversizedTokens = Array.from({ length: 3000 }, (_, index) => {
      return `fact-${index}`;
    }).join(" ");
    await writeFile(path, oversizedTokens, "utf8");
    await expect(
      loadPiSandboxMemoryRecall(readySelection(oversizedTokens), root),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "invalid", reason: "token-overflow" },
    });

    await writeFile(path, "bounded memory", "utf8");
    const bounded = readySelection("bounded memory");
    await expect(
      loadPiSandboxMemoryRecall(
        { ...bounded, tokenCount: bounded.tokenCount + 1 },
        root,
      ),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "stale", reason: "token-mismatch" },
    });
  });
});
