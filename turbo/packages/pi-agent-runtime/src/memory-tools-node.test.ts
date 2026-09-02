import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer as createNetServer } from "node:net";

import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { afterEach, describe, expect, it } from "vitest";

import type {
  PiMemoryRecallSelection,
  PiMemoryToolSourceUse,
} from "./api-types";
import {
  createPiMemoryTools,
  PI_MEMORY_TOOL_MAX_DIRECTORY_ENTRIES,
  PI_MEMORY_TOOL_MAX_DURATION_MS,
  PI_MEMORY_TOOL_MAX_FILE_BYTES,
  PI_MEMORY_TOOL_MAX_PATH_BYTES,
  PI_MEMORY_TOOL_MAX_QUERY_BYTES,
  PI_MEMORY_TOOL_MAX_RENDERED_BYTES,
  PI_MEMORY_TOOL_MAX_RENDERED_TOKENS,
  PI_MEMORY_TOOL_MAX_RETURNED_LINES,
  PI_MEMORY_TOOL_MAX_SEARCH_MATCHES,
  PI_MEMORY_TOOL_MAX_TOTAL_SCANNED_BYTES,
  PI_MEMORY_TOOL_MAX_TRAVERSAL_DEPTH,
  PI_MEMORY_TOOL_MAX_VISITED_ENTRIES,
} from "./memory-tools-node";

const SELECTION = {
  status: "no-content" as const,
  memoryStorageId: "memory-storage-a",
  storageVersionId: "memory-version-a",
};
const TRUNCATION_MARKER =
  "[truncated: a deterministic memory tool cap was reached]";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function memoryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-tools-"));
  temporaryDirectories.push(root);
  return root;
}

async function put(root: string, path: string, content: string | Buffer) {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function tools(args: {
  readonly root: string;
  readonly events?: PiMemoryToolSourceUse[];
  readonly now?: () => number;
  readonly afterValidatedOpen?: (path: string) => Promise<void>;
  readonly sinkThrows?: boolean;
  readonly mode?: "api-first" | "sandbox";
  readonly selection?: PiMemoryRecallSelection;
}) {
  return createPiMemoryTools({
    mode: args.mode ?? "sandbox",
    selection: args.selection ?? SELECTION,
    memoryRoot: args.root,
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.afterValidatedOpen === undefined
      ? {}
      : { testHooks: { afterValidatedOpen: args.afterValidatedOpen } }),
    onSourceUse(event) {
      args.events?.push(event);
      if (args.sinkThrows) {
        throw new Error("telemetry unavailable");
      }
    },
  });
}

function namedTool(
  registry: ReturnType<typeof tools>,
  name: "memories_list" | "memories_read" | "memories_search",
) {
  const tool = registry.find((candidate) => {
    return candidate.name === name;
  });
  if (!tool) {
    throw new Error(`Missing test tool: ${name}`);
  }
  return tool;
}

async function executeText(
  registry: ReturnType<typeof tools>,
  name: "memories_list" | "memories_read" | "memories_search",
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ readonly text: string; readonly details: unknown }> {
  const result = await namedTool(registry, name).execute(
    "memory-tool-call",
    params as never,
    signal,
    undefined,
    undefined as never,
  );
  const content = result.content?.[0];
  if (content?.type !== "text") {
    throw new Error("Memory tool test expected text content");
  }
  return { text: content.text, details: result.details };
}

function expectSanitizedFailure(promise: Promise<unknown>, root: string) {
  return expect(promise).rejects.toSatisfy((error: unknown) => {
    return (
      error instanceof Error &&
      !error.message.includes(root) &&
      !error.message.includes("ENOENT") &&
      !error.message.includes("secret")
    );
  });
}

describe("first-party Pi memory tools", () => {
  it("lists, searches, and reads the existing layout deterministically", async () => {
    const root = await memoryRoot();
    await put(root, "memory_summary.md", "summary only");
    await put(root, "MEMORY.md", "Index\nNeedle in root\nTail");
    await put(root, "legacy-topic.md", "Legacy NEEDLE");
    await put(root, "rollout_summaries/run.jsonl", "needle in rollout");
    await put(root, "skills/demo/SKILL.md", "Skill needle");
    await put(root, ".git/secret", "secret needle");
    const registry = tools({ root });

    const listed = await executeText(registry, "memories_list", {});
    const listRecords = listed.text.split("\n").filter((line) => {
      return line.startsWith("directory\t") || line.startsWith("file\t");
    });
    const listPaths = listRecords.map((record) => {
      return record.split("\t")[1];
    });
    expect(listPaths).toStrictEqual([...listPaths].sort());
    expect(listed.text).toContain("file\tMEMORY.md");
    expect(listed.text).toContain("file\tlegacy-topic.md");
    expect(listed.text).toContain("file\trollout_summaries/run.jsonl");
    expect(listed.text).toContain("file\tskills/demo/SKILL.md");
    expect(listed.text).not.toContain(".git");

    const searched = await executeText(registry, "memories_search", {
      query: "needle",
    });
    expect(searched.text).toContain("MEMORY.md:2: Needle in root");
    expect(searched.text).toContain("legacy-topic.md:1: Legacy NEEDLE");
    expect(searched.text).toContain(
      "rollout_summaries/run.jsonl:1: needle in rollout",
    );
    expect(searched.text).toContain("skills/demo/SKILL.md:1: Skill needle");
    expect(searched.text).not.toContain("secret");

    const read = await executeText(registry, "memories_read", {
      path: "MEMORY.md",
      start_line: 2,
      line_count: 2,
    });
    expect(read.text).toContain("2: Needle in root\n3: Tail");
    expect(read.text).not.toContain("1: Index");
    expect(read.details).toStrictEqual({});
  });

  it("rejects every hostile path form and every .git segment", async () => {
    const root = await memoryRoot();
    await put(root, "safe.md", "safe");
    const registry = tools({ root });
    const hostilePaths = [
      "",
      "/etc/passwd",
      "C:/Windows/system.ini",
      "C:\\Windows\\system.ini",
      "//server/share",
      "safe//file",
      "safe\\file",
      ".",
      "..",
      "safe/./file",
      "safe/../file",
      ".git",
      ".git/config",
      "safe/.git/config",
      "safe\u0000file",
      "safe\u001ffile",
    ];

    for (const path of hostilePaths) {
      await expectSanitizedFailure(
        executeText(registry, "memories_read", { path }),
        root,
      );
    }
  });

  it("pins exact input, file, line, match, scan, and rendered boundaries", async () => {
    const root = await memoryRoot();
    const segment = "a".repeat(63);
    const maxPath = `${[segment, segment, segment, segment, segment, segment, segment].join("/")}/${"b".repeat(64)}`;
    expect(Buffer.byteLength(maxPath)).toBe(PI_MEMORY_TOOL_MAX_PATH_BYTES);
    await put(root, maxPath, "at exact path boundary");
    const events: PiMemoryToolSourceUse[] = [];
    const registry = tools({
      root,
      events,
      now: () => {
        return 0;
      },
    });

    await expect(
      executeText(registry, "memories_read", { path: maxPath }),
    ).resolves.toMatchObject({ text: expect.stringContaining("exact path") });
    await expectSanitizedFailure(
      executeText(registry, "memories_read", { path: `${maxPath}x` }),
      root,
    );

    const exactQuery = "q".repeat(PI_MEMORY_TOOL_MAX_QUERY_BYTES);
    await expect(
      executeText(registry, "memories_search", { query: exactQuery }),
    ).resolves.toBeDefined();
    await expectSanitizedFailure(
      executeText(registry, "memories_search", {
        query: `${exactQuery}q`,
      }),
      root,
    );

    await put(root, "exact-size.md", "a".repeat(PI_MEMORY_TOOL_MAX_FILE_BYTES));
    await expect(
      executeText(registry, "memories_read", { path: "exact-size.md" }),
    ).resolves.toBeDefined();
    await put(
      root,
      "oversized.md",
      "secret".padEnd(PI_MEMORY_TOOL_MAX_FILE_BYTES + 1, "x"),
    );
    await expectSanitizedFailure(
      executeText(registry, "memories_read", { path: "oversized.md" }),
      root,
    );

    await put(
      root,
      "lines.md",
      `${"\n".repeat(PI_MEMORY_TOOL_MAX_RETURNED_LINES)}x`,
    );
    const lines = await executeText(registry, "memories_read", {
      path: "lines.md",
      line_count: PI_MEMORY_TOOL_MAX_RETURNED_LINES,
    });
    expect(lines.text).toContain(`${PI_MEMORY_TOOL_MAX_RETURNED_LINES}: `);
    expect(lines.text).toContain(TRUNCATION_MARKER);

    await put(
      root,
      "matches.md",
      Array.from({ length: PI_MEMORY_TOOL_MAX_SEARCH_MATCHES + 1 }, () => {
        return "match";
      }).join("\n"),
    );
    const matches = await executeText(registry, "memories_search", {
      query: "match",
    });
    expect(matches.text).toContain(
      `matches.md:${PI_MEMORY_TOOL_MAX_SEARCH_MATCHES}: match`,
    );
    expect(matches.text).not.toContain(
      `matches.md:${PI_MEMORY_TOOL_MAX_SEARCH_MATCHES + 1}: match`,
    );
    expect(matches.text).toContain(TRUNCATION_MARKER);

    const rendered = await executeText(registry, "memories_read", {
      path: "exact-size.md",
    });
    expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(
      PI_MEMORY_TOOL_MAX_RENDERED_BYTES,
    );
    expect(encode(rendered.text).length).toBeLessThanOrEqual(
      PI_MEMORY_TOOL_MAX_RENDERED_TOKENS,
    );

    expect(
      events.some((event) => {
        return event.scannedBytes === PI_MEMORY_TOOL_MAX_FILE_BYTES;
      }),
    ).toBe(true);
  });

  it("caps traversal and aggregate scanning without crossing the limits", async () => {
    const root = await memoryRoot();
    for (
      let index = 0;
      index < PI_MEMORY_TOOL_MAX_VISITED_ENTRIES + 1;
      index += 1
    ) {
      await put(root, `entries/${index.toString().padStart(3, "0")}.md`, "");
    }
    const visitEvents: PiMemoryToolSourceUse[] = [];
    const visitResult = await executeText(
      tools({
        root,
        events: visitEvents,
        now: () => {
          return 0;
        },
      }),
      "memories_search",
      { path: "entries", query: "absent" },
    );
    expect(visitResult.text).toContain(TRUNCATION_MARKER);
    expect(visitEvents).toStrictEqual([
      expect.objectContaining({
        visitedEntries: PI_MEMORY_TOOL_MAX_VISITED_ENTRIES,
        scannedFiles: PI_MEMORY_TOOL_MAX_VISITED_ENTRIES,
        truncated: true,
      }),
    ]);

    const scanRoot = await memoryRoot();
    const oneMiB = "x".repeat(PI_MEMORY_TOOL_MAX_FILE_BYTES);
    const exactFileCount =
      PI_MEMORY_TOOL_MAX_TOTAL_SCANNED_BYTES / PI_MEMORY_TOOL_MAX_FILE_BYTES;
    for (let index = 0; index <= exactFileCount; index += 1) {
      await put(scanRoot, `${index}.md`, oneMiB);
    }
    const scanEvents: PiMemoryToolSourceUse[] = [];
    const scanResult = await executeText(
      tools({
        root: scanRoot,
        events: scanEvents,
        now: () => {
          return 0;
        },
      }),
      "memories_search",
      { query: "absent" },
    );
    expect(scanResult.text).toContain(TRUNCATION_MARKER);
    expect(scanEvents).toStrictEqual([
      expect.objectContaining({
        scannedBytes: PI_MEMORY_TOOL_MAX_TOTAL_SCANNED_BYTES,
        scannedFiles: exactFileCount,
        truncated: true,
      }),
    ]);
  });

  it("fails closed before materializing an oversized single directory", async () => {
    const root = await memoryRoot();
    for (
      let index = 0;
      index < PI_MEMORY_TOOL_MAX_DIRECTORY_ENTRIES + 1;
      index += 1
    ) {
      await put(root, `${index.toString().padStart(4, "0")}.md`, "");
    }
    await expectSanitizedFailure(
      executeText(
        tools({
          root,
          now() {
            return 0;
          },
        }),
        "memories_list",
        {},
      ),
      root,
    );
  });

  it("never traverses beyond the fixed depth boundary", async () => {
    const root = await memoryRoot();
    const depthSeven = Array.from(
      { length: PI_MEMORY_TOOL_MAX_TRAVERSAL_DEPTH - 1 },
      (_, index) => {
        return `d${index.toString()}`;
      },
    ).join("/");
    const depthEightDirectory = `${depthSeven}/d${(
      PI_MEMORY_TOOL_MAX_TRAVERSAL_DEPTH - 1
    ).toString()}`;
    await put(root, `${depthSeven}/visible.md`, "depth eight needle");
    await put(root, `${depthEightDirectory}/hidden.md`, "depth nine needle");
    const registry = tools({
      root,
      now() {
        return 0;
      },
    });

    const listed = await executeText(registry, "memories_list", {});
    expect(listed.text).toContain(`file\t${depthSeven}/visible.md`);
    expect(listed.text).toContain(`directory\t${depthEightDirectory}`);
    expect(listed.text).not.toContain("hidden.md");
    expect(listed.text).toContain(TRUNCATION_MARKER);

    const searched = await executeText(registry, "memories_search", {
      query: "needle",
    });
    expect(searched.text).toContain(`${depthSeven}/visible.md:1`);
    expect(searched.text).not.toContain("hidden.md");
    expect(searched.text).toContain(TRUNCATION_MARKER);
    await expectSanitizedFailure(
      executeText(registry, "memories_read", {
        path: `${depthEightDirectory}/hidden.md`,
      }),
      root,
    );
  });

  it("fails closed for symlinks, non-regular text, and replacement races", async () => {
    const root = await memoryRoot();
    const outside = await memoryRoot();
    await put(outside, "secret.md", "secret outside bytes");
    await symlink(outside, join(root, "linked-parent"));
    await symlink(join(outside, "secret.md"), join(root, "linked-file.md"));
    await mkdir(join(root, "directory.md"));
    await put(root, "invalid.md", Buffer.from([0xff, 0xfe, 0xfd]));
    await put(root, "binary.md", Buffer.from("safe\u0000secret"));
    await put(root, "parent-file", "not a directory");
    const registry = tools({ root });

    for (const path of [
      "linked-parent/secret.md",
      "linked-file.md",
      "directory.md",
      "invalid.md",
      "binary.md",
      "parent-file/child.md",
      "missing.md",
    ]) {
      await expectSanitizedFailure(
        executeText(registry, "memories_read", { path }),
        root,
      );
    }

    const socketPath = join(root, "socket-node");
    const socketServer = createNetServer();
    await new Promise<void>((resolve, reject) => {
      socketServer.once("error", reject);
      socketServer.listen(socketPath, () => {
        socketServer.off("error", reject);
        resolve();
      });
    });
    try {
      await expectSanitizedFailure(
        executeText(registry, "memories_read", { path: "socket-node" }),
        root,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        socketServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }

    const symlinkedRoot = join(outside, "root-link");
    await symlink(root, symlinkedRoot);
    await expectSanitizedFailure(
      executeText(tools({ root: symlinkedRoot }), "memories_read", {
        path: "binary.md",
      }),
      root,
    );

    await put(root, "race.md", "original secret bytes");
    const raceEvents: PiMemoryToolSourceUse[] = [];
    const raced = tools({
      root,
      events: raceEvents,
      async afterValidatedOpen(path) {
        if (path === "race.md") {
          await rename(join(root, path), join(root, "moved.md"));
          await writeFile(join(root, path), "replacement secret bytes");
        }
      },
    });
    await expectSanitizedFailure(
      executeText(raced, "memories_read", { path: "race.md" }),
      root,
    );
    expect(raceEvents).toStrictEqual([
      expect.objectContaining({
        operation: "read",
        outcome: "error",
        errorClass: "path-race",
        returnedLines: 0,
      }),
    ]);

    await put(root, "parent/child.md", "original parent bytes");
    const parentRace = tools({
      root,
      async afterValidatedOpen(path) {
        if (path === "parent/child.md") {
          await rename(join(root, "parent"), join(root, "moved-parent"));
          await put(root, "parent/child.md", "replacement parent bytes");
        }
      },
    });
    await expectSanitizedFailure(
      executeText(parentRace, "memories_read", { path: "parent/child.md" }),
      root,
    );

    const replacedRoot = await memoryRoot();
    await put(replacedRoot, "root-race.md", "original root bytes");
    const movedRoot = `${replacedRoot}-moved`;
    temporaryDirectories.push(movedRoot);
    const rootRace = tools({
      root: replacedRoot,
      async afterValidatedOpen(path) {
        await rename(replacedRoot, movedRoot);
        await mkdir(replacedRoot);
        await put(replacedRoot, path, "replacement root bytes");
      },
    });
    await expectSanitizedFailure(
      executeText(rootRace, "memories_read", { path: "root-race.md" }),
      replacedRoot,
    );
  });

  it("stops promptly on abort and timeout and keeps failures ordinary", async () => {
    const root = await memoryRoot();
    await put(root, "safe.md", "safe");
    const controller = new AbortController();
    controller.abort();
    await expectSanitizedFailure(
      executeText(
        tools({ root }),
        "memories_read",
        { path: "safe.md" },
        controller.signal,
      ),
      root,
    );

    let tick = 0;
    await expectSanitizedFailure(
      executeText(
        tools({
          root,
          now() {
            tick += PI_MEMORY_TOOL_MAX_DURATION_MS;
            return tick;
          },
        }),
        "memories_read",
        { path: "safe.md" },
      ),
      root,
    );
  });

  it("emits content-free source use from validated paths and ignores sink failure", async () => {
    const root = await memoryRoot();
    await put(root, "topic.md", "super-secret-query and private contents");
    const events: PiMemoryToolSourceUse[] = [];
    const registry = tools({ root, events });
    await executeText(registry, "memories_search", {
      query: "super-secret-query",
    });

    expect(events).toStrictEqual([
      expect.objectContaining({
        operation: "search",
        outcome: "success",
        memoryStorageId: SELECTION.memoryStorageId,
        storageVersionId: SELECTION.storageVersionId,
        pathHash: createHash("sha256").update("").digest("hex"),
        scannedFiles: 1,
        returnedMatches: 1,
      }),
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("topic.md");
    expect(serialized).not.toContain("super-secret-query");
    expect(serialized).not.toContain("private contents");

    await expect(
      executeText(tools({ root, sinkThrows: true }), "memories_read", {
        path: "topic.md",
      }),
    ).resolves.toMatchObject({ details: {} });
  });

  it("keeps an active version A registry isolated from a later version B mount", async () => {
    const rootA = await memoryRoot();
    const rootB = await memoryRoot();
    await put(rootA, "MEMORY.md", "pinned version A");
    await put(rootB, "MEMORY.md", "new version B");
    const events: PiMemoryToolSourceUse[] = [];
    const versionA = tools({ root: rootA, events });
    const versionB = tools({
      root: rootB,
      events,
      selection: {
        status: "no-content",
        memoryStorageId: "memory-storage-a",
        storageVersionId: "memory-version-b",
      },
    });

    const firstA = await executeText(versionA, "memories_read", {
      path: "MEMORY.md",
    });
    const newB = await executeText(versionB, "memories_read", {
      path: "MEMORY.md",
    });
    const secondA = await executeText(versionA, "memories_read", {
      path: "MEMORY.md",
    });

    expect(firstA.text).toContain("pinned version A");
    expect(newB.text).toContain("new version B");
    expect(secondA.text).toContain("pinned version A");
    expect(
      events.map((event) => {
        return event.storageVersionId;
      }),
    ).toStrictEqual([
      "memory-version-a",
      "memory-version-b",
      "memory-version-a",
    ]);
  });

  it("never performs API-first filesystem work", async () => {
    const missingRoot = join(tmpdir(), "pi-memory-root-does-not-exist");
    const registry = tools({ root: missingRoot, mode: "api-first" });
    await expect(
      executeText(registry, "memories_read", { path: "MEMORY.md" }),
    ).rejects.toThrow("sandbox ownership transfer");
  });
});
