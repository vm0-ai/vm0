import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer as createNetServer } from "node:net";

import {
  PI_MEMORY_SUMMARY_MAX_BYTES,
  PI_MEMORY_SUMMARY_MAX_TOKENS,
} from "@okouai/api-contracts/contracts/runners";
import {
  MAX_FILE_SIZE_BYTES,
  STORAGE_MANIFEST_MAX_FILES,
  STORAGE_MANIFEST_MAX_PATH_BYTES,
} from "@okouai/api-contracts/contracts/storages";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPiMemoryPhase2Workspace,
  Phase2InputInvalidError,
  Phase2OutputInvalidError,
  PI_MEMORY_PHASE2_EVIDENCE_SLUG_MAX_BYTES,
  PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES,
  PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES,
  piEvidencePath,
  removePiMemoryPhase2Workspace,
  snapshotPiMemoryPhase2Input,
  truncatePiMemoryPhase2WorkspaceDiff,
  validatePiMemoryPhase2Output,
  type Phase2PrivateWorkspace,
} from "./phase2-memory-filesystem";
import {
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_BYTES,
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILE_BYTES,
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILES,
  PI_MEMORY_PHASE2_MEMORY_MAX_BYTES,
  PI_MEMORY_PHASE2_PREPARED_MAX_BYTES,
  PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES,
  type PiMemoryPhase2BaseFile,
  type PiMemoryPhase2ConsolidationArgs,
  type PiMemoryPhase2SelectedSnapshot,
} from "./phase2-memory-types";

const temporaryDirectories: string[] = [];
const EMPTY_HASH = createHash("sha256").update("").digest("hex");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await removePiMemoryPhase2Workspace(directory);
    }),
  );
});

function baseFile(
  path: string,
  content: string | Uint8Array,
): PiMemoryPhase2BaseFile {
  const bytes = Buffer.from(content);
  return {
    type: "file",
    path,
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    bytes,
  };
}

function selected(
  piSessionId: string,
  overrides: Partial<PiMemoryPhase2SelectedSnapshot> = {},
): PiMemoryPhase2SelectedSnapshot {
  return {
    piSessionId,
    sourceRunId: `run-${piSessionId}`,
    sourceHistoryHash: createHash("sha256")
      .update(`history-${piSessionId}`)
      .digest("hex"),
    sourceCompletedAt: new Date("2026-09-03T01:02:03.000Z"),
    rawMemory: `raw-${piSessionId}`,
    rolloutSummary: `summary-${piSessionId}`,
    rolloutSlug: null,
    ...overrides,
  };
}

function consolidationArgs(
  baseFiles: readonly PiMemoryPhase2BaseFile[],
  selectedSnapshots: readonly PiMemoryPhase2SelectedSnapshot[] = [],
): PiMemoryPhase2ConsolidationArgs {
  return {
    orgId: "org-phase2",
    userId: "user-phase2",
    memoryStorageId: "storage-phase2",
    claimedRevision: 7,
    leaseToken: "lease-phase2",
    baseFiles,
    selected: selectedSnapshots,
    model: {
      provider: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "unused-test-key",
      model: "gpt-5.6-terra",
      api: "openai-responses",
    },
    heartbeat: async () => {
      return true;
    },
  };
}

async function freshWorkspace(
  baseFiles: readonly PiMemoryPhase2BaseFile[],
  selectedSnapshots: readonly PiMemoryPhase2SelectedSnapshot[] = [],
): Promise<Phase2PrivateWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-phase2-fs-test-"));
  temporaryDirectories.push(root);
  const input = snapshotPiMemoryPhase2Input(
    consolidationArgs(baseFiles, selectedSnapshots),
    new AbortController().signal,
  );
  return await createPiMemoryPhase2Workspace(root, input);
}

async function put(
  workspace: Phase2PrivateWorkspace,
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const target = join(workspace.memoryRoot, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

const VALID_BASE = [
  baseFile("MEMORY.md", "# Task Group: existing\n"),
  baseFile("memory_summary.md", "v1\n## User Profile\n- existing\n"),
  baseFile(".git/config", "codex-git-state"),
  baseFile("legacy-topic.md", "legacy"),
  baseFile("raw_memories.md", "codex raw"),
  baseFile("extensions/preserved.txt", "extension"),
  baseFile("rollout_summaries/codex.md", "codex evidence"),
] as const;

describe("Pi memory Phase 2 filesystem", () => {
  it("pins every frozen size and count boundary", () => {
    expect(PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(PI_MEMORY_SUMMARY_MAX_BYTES).toBe(64 * 1024);
    expect(PI_MEMORY_SUMMARY_MAX_TOKENS).toBe(2500);
    expect(STORAGE_MANIFEST_MAX_FILES).toBe(50_000);
    expect(STORAGE_MANIFEST_MAX_PATH_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_FILE_SIZE_BYTES).toBe(100 * 1024 * 1024);
    expect(PI_MEMORY_PHASE2_PREPARED_MAX_BYTES).toBe(128 * 1024 * 1024);
    expect(PI_MEMORY_PHASE2_MEMORY_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILES).toBe(256);
    expect(PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILE_BYTES).toBe(1024 * 1024);
    expect(PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_BYTES).toBe(16 * 1024 * 1024);
    expect(PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES).toBe(256);
    expect(PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES).toBe(21_036_800);

    const empty = snapshotPiMemoryPhase2Input(
      consolidationArgs([]),
      new AbortController().signal,
    );
    expect(empty.selectionDigest).toBe(
      "f95c6835f8a93234e88b26bc2162bd3cf8defd709037f6eefb14ee6ae3d56e48",
    );
    const one = snapshotPiMemoryPhase2Input(
      consolidationArgs(
        [],
        [selected("session-a", { sourceHistoryHash: "a".repeat(64) })],
      ),
      new AbortController().signal,
    );
    expect(one.selectionDigest).toBe(
      "24a9bc5c377eb5bfc66e9976218eb1c99ecb6461e2593788b2c752f4437288b2",
    );
    expect(() => {
      snapshotPiMemoryPhase2Input(
        consolidationArgs(
          [],
          [selected("session", { sourceRunId: "r".repeat(256) })],
        ),
        new AbortController().signal,
      );
    }).toThrow(Phase2InputInvalidError);
  });

  it("rejects unsafe, ambiguous, non-file, and mismatched base inventory", () => {
    const valid = baseFile("safe.md", "safe");
    const invalidCases: readonly (readonly PiMemoryPhase2BaseFile[])[] = [
      [baseFile("/absolute.md", "x")],
      [baseFile("../parent.md", "x")],
      [baseFile("dir/./child.md", "x")],
      [baseFile("dir\\child.md", "x")],
      [baseFile("nul\0child.md", "x")],
      [valid, valid],
      [valid, baseFile("SAFE.md", "other")],
      [baseFile("prefix", "x"), baseFile("prefix/child", "x")],
      [{ ...valid, type: "directory" } as unknown as PiMemoryPhase2BaseFile],
      [{ ...valid, hash: "0".repeat(64) }],
      [{ ...valid, size: valid.size + 1 }],
      [{ ...valid, size: MAX_FILE_SIZE_BYTES + 1 }],
    ];
    for (const files of invalidCases) {
      expect(() => {
        snapshotPiMemoryPhase2Input(
          consolidationArgs(files),
          new AbortController().signal,
        );
      }).toThrow(Phase2InputInvalidError);
    }
  });

  it("preflights file-count, path-byte, per-file, and total bounds before copying bytes", () => {
    const empty = {
      type: "file" as const,
      hash: EMPTY_HASH,
      size: 0,
      bytes: new Uint8Array(),
    };
    const tooMany = Array.from(
      { length: STORAGE_MANIFEST_MAX_FILES + 1 },
      (_, index) => {
        return { ...empty, path: `many/${index.toString()}` };
      },
    );
    const tooManyPathBytes = Array.from({ length: 49_000 }, (_, index) => {
      return {
        ...empty,
        path: `paths/${index.toString().padStart(5, "0")}-${"x".repeat(170)}`,
      };
    });
    const tooLargeTotal = Array.from({ length: 129 }, (_, index) => {
      return {
        ...empty,
        path: `total/${index.toString()}`,
        size: 1024 * 1024,
      };
    });
    for (const files of [tooMany, tooManyPathBytes, tooLargeTotal]) {
      expect(() => {
        snapshotPiMemoryPhase2Input(
          consolidationArgs(files),
          new AbortController().signal,
        );
      }).toThrow(Phase2InputInvalidError);
    }
  });

  it("projects ordered hashed evidence, prunes nested Pi only, and keeps private inputs private", async () => {
    const stale = baseFile("rollout_summaries/pi/stale.md", "stale");
    const replaced = baseFile(
      piEvidencePath("session-z"),
      "source_history_hash: old-history",
    );
    const snapshots = [
      selected("session-z"),
      selected("session-a", {
        rolloutSlug: `  Résumé / ${"Safe-".repeat(20)} secret_VALUE  `,
      }),
    ];
    const workspace = await freshWorkspace(
      [...VALID_BASE, stale, replaced],
      snapshots,
    );
    const evidenceA = piEvidencePath(
      "session-a",
      snapshots[1]?.rolloutSlug ?? null,
    );
    const evidenceZ = piEvidencePath("session-z");
    expect(evidenceA).toMatch(
      /^rollout_summaries\/pi\/[a-f0-9]{64}-[a-z0-9-]+\.md$/u,
    );
    const slug = evidenceA.slice(evidenceA.lastIndexOf("-") + 1, -3);
    expect(Buffer.byteLength(slug)).toBeLessThanOrEqual(
      PI_MEMORY_PHASE2_EVIDENCE_SLUG_MAX_BYTES,
    );
    expect(workspace.agentBaseline.has(evidenceA)).toBe(true);
    expect(workspace.agentBaseline.has(evidenceZ)).toBe(true);
    expect(workspace.agentBaseline.get(evidenceZ)?.equals(replaced.bytes)).toBe(
      false,
    );
    expect(workspace.agentBaseline.has("rollout_summaries/pi/stale.md")).toBe(
      false,
    );
    expect(
      workspace.agentBaseline.get("rollout_summaries/codex.md")?.toString(),
    ).toBe("codex evidence");

    const evidence = await readFile(
      join(workspace.memoryRoot, ...evidenceA.split("/")),
      "utf8",
    );
    expect(evidence).toContain('pi_session_id: "session-a"');
    expect(evidence).toContain('source_run_id: "run-session-a"');
    expect(evidence).toContain("source_history_hash:");
    expect(evidence).toContain(
      'source_completed_at: "2026-09-03T01:02:03.000Z"',
    );
    expect(evidence).toContain("summary-session-a");
    expect(evidence).not.toContain("raw-session-a");

    const privateRaw = await readFile(
      join(workspace.inputsRoot, "raw-memories.md"),
      "utf8",
    );
    expect(privateRaw.indexOf("session-a")).toBeLessThan(
      privateRaw.indexOf("session-z"),
    );
    expect(privateRaw).toContain("raw-session-a");
    const privateDiff = await readFile(
      join(workspace.inputsRoot, "workspace-diff.md"),
    );
    expect(privateDiff.length).toBeLessThanOrEqual(
      PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES,
    );
    expect(workspace.diff).toMatchObject({ added: 1, changed: 1, deleted: 1 });

    const prepared = await validatePiMemoryPhase2Output(
      workspace,
      "storage-phase2",
    );
    expect(
      prepared.files.map((file) => {
        return file.path;
      }),
    ).toStrictEqual(
      prepared.files
        .map((file) => {
          return file.path;
        })
        .slice()
        .sort(),
    );
    const canonicalContentLines = prepared.files
      .map((file) => {
        return `${file.path}:${file.hash}`;
      })
      .sort();
    expect(prepared.contentIdentity).toBe(
      createHash("sha256")
        .update(`storage:storage-phase2\n${canonicalContentLines.join("\n")}`)
        .digest("hex"),
    );
    expect(
      prepared.files.some((file) => {
        return file.path.startsWith("inputs/");
      }),
    ).toBe(false);
    expect(
      prepared.files.find((file) => {
        return file.path === ".git/config";
      }),
    ).toMatchObject({
      path: ".git/config",
      hash: baseFile(".git/config", "codex-git-state").hash,
      size: Buffer.byteLength("codex-git-state"),
    });

    const permuted = await freshWorkspace(
      [replaced, stale, ...[...VALID_BASE].reverse()],
      [...snapshots].reverse(),
    );
    const permutedPrepared = await validatePiMemoryPhase2Output(
      permuted,
      "storage-phase2",
    );
    expect(permutedPrepared).toStrictEqual(prepared);
  });

  it("truncates private multibyte diffs on a valid UTF-8 boundary", () => {
    const input = `${"a".repeat(PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES - 2)}💡💡`;
    const bounded = truncatePiMemoryPhase2WorkspaceDiff(input);
    expect(bounded.truncated).toBe(true);
    expect(bounded.content.length).toBeLessThanOrEqual(
      PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES,
    );
    expect(() => {
      new TextDecoder("utf8", { fatal: true }).decode(bounded.content);
    }).not.toThrow();
    expect(bounded.content.toString()).toContain("[workspace diff truncated]");
  });

  it("accepts only the two consolidated files and valid optional skills as mutable", async () => {
    const workspace = await freshWorkspace(VALID_BASE);
    await put(workspace, "MEMORY.md", "# Task Group: updated\n");
    await put(
      workspace,
      "memory_summary.md",
      "v1\n## User Profile\n- updated\n",
    );
    await put(
      workspace,
      "skills/reusable/SKILL.md",
      "---\nname: reusable\ndescription: test\n---\n\n# Reusable\n",
    );
    await put(workspace, "skills/reusable/reference.md", "reference");

    const prepared = await validatePiMemoryPhase2Output(
      workspace,
      "storage-phase2",
    );
    const files = new Map(
      prepared.files.map((file) => {
        return [
          file.path,
          Buffer.from(file.contentBase64, "base64").toString(),
        ];
      }),
    );
    expect(files.get("MEMORY.md")).toContain("updated");
    expect(files.get(".git/config")).toBe("codex-git-state");
    expect(files.get("legacy-topic.md")).toBe("legacy");
    expect(files.get("raw_memories.md")).toBe("codex raw");
    expect(files.get("extensions/preserved.txt")).toBe("extension");
    expect(files.get("rollout_summaries/codex.md")).toBe("codex evidence");
  });

  it("rejects invalid generated text, skills, immutable changes, links, and special entries", async () => {
    const invalidMutations: ReadonlyArray<
      (workspace: Phase2PrivateWorkspace) => Promise<void>
    > = [
      async (workspace) => {
        await put(workspace, "MEMORY.md", "");
      },
      async (workspace) => {
        await unlink(join(workspace.memoryRoot, "MEMORY.md"));
      },
      async (workspace) => {
        await put(workspace, "MEMORY.md", Buffer.from([0xff]));
      },
      async (workspace) => {
        await put(
          workspace,
          "MEMORY.md",
          "x".repeat(PI_MEMORY_PHASE2_MEMORY_MAX_BYTES + 1),
        );
      },
      async (workspace) => {
        await put(workspace, "memory_summary.md", "V1\nwrong\n");
      },
      async (workspace) => {
        await put(workspace, "memory_summary.md", Buffer.from([0xff]));
      },
      async (workspace) => {
        await put(
          workspace,
          "memory_summary.md",
          `v1\n${"s".repeat(PI_MEMORY_SUMMARY_MAX_BYTES)}`,
        );
      },
      async (workspace) => {
        const tooManyTokens = `v1\n${" token".repeat(
          PI_MEMORY_SUMMARY_MAX_TOKENS + 100,
        )}`;
        expect(encode(tooManyTokens).length).toBeGreaterThan(
          PI_MEMORY_SUMMARY_MAX_TOKENS,
        );
        await put(workspace, "memory_summary.md", tooManyTokens);
      },
      async (workspace) => {
        await put(workspace, "skills/missing-manifest/reference.md", "x");
      },
      async (workspace) => {
        await put(
          workspace,
          "skills/bad-manifest/SKILL.md",
          "---\nname: another-name\ndescription: mismatch\n---\n",
        );
      },
      async (workspace) => {
        await put(workspace, "skills/Bad_Name/SKILL.md", "x");
      },
      async (workspace) => {
        await put(
          workspace,
          "skills/large/SKILL.md",
          "x".repeat(PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILE_BYTES + 1),
        );
      },
      async (workspace) => {
        await put(
          workspace,
          "skills/too-many/SKILL.md",
          "---\nname: too-many\ndescription: count boundary\n---\n",
        );
        await Promise.all(
          Array.from(
            { length: PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILES },
            async (_, index) => {
              await put(
                workspace,
                `skills/too-many/file-${index.toString()}.md`,
                "x",
              );
            },
          ),
        );
      },
      async (workspace) => {
        await put(
          workspace,
          "skills/too-large-total/SKILL.md",
          "---\nname: too-large-total\ndescription: total boundary\n---\n",
        );
        await Promise.all(
          Array.from({ length: 17 }, async (_, index) => {
            await put(
              workspace,
              `skills/too-large-total/file-${index.toString()}.md`,
              "x".repeat(1024 * 1024),
            );
          }),
        );
      },
      async (workspace) => {
        await put(workspace, "legacy-topic.md", "mutated");
      },
      async (workspace) => {
        const target = join(workspace.memoryRoot, "memory_summary.md");
        await unlink(target);
        await symlink("MEMORY.md", target);
      },
      async (workspace) => {
        const outside = join(workspace.root, "hardlink-source");
        await writeFile(outside, "v1\n## User Profile\n");
        const target = join(workspace.memoryRoot, "memory_summary.md");
        await unlink(target);
        await link(outside, target);
      },
    ];

    for (const mutate of invalidMutations) {
      const workspace = await freshWorkspace(VALID_BASE);
      await mutate(workspace);
      await expect(
        validatePiMemoryPhase2Output(workspace, "storage-phase2"),
      ).rejects.toBeInstanceOf(Phase2OutputInvalidError);
    }
  });

  it("restores private permissions for cleanup without following links", async () => {
    const workspace = await freshWorkspace(VALID_BASE);
    const outside = join(
      tmpdir(),
      `pi-phase2-outside-${process.pid.toString()}`,
    );
    await writeFile(outside, "outside-safe");
    await symlink(outside, join(workspace.root, "cleanup-link"));
    await removePiMemoryPhase2Workspace(workspace.root);
    expect(await readFile(outside, "utf8")).toBe("outside-safe");
    await rm(outside);
    temporaryDirectories.splice(
      temporaryDirectories.indexOf(workspace.root),
      1,
    );
  });

  it("rejects a special filesystem entry without returning files", async () => {
    const workspace = await freshWorkspace(VALID_BASE);
    const socketPath = join(workspace.memoryRoot, "special.sock");
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      await expect(
        validatePiMemoryPhase2Output(workspace, "storage-phase2"),
      ).rejects.toBeInstanceOf(Phase2OutputInvalidError);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });
});
