import { describe, expect, it } from "vitest";

import {
  computeChangeSet,
  type MemoryFileMap,
} from "../memory-activity-diff.service";

function fileMap(
  entries: readonly (readonly [string, string, string])[],
): MemoryFileMap {
  return new Map(
    entries.map(([path, hash, content]) => {
      return [path, { hash, content }];
    }),
  );
}

describe("computeChangeSet", () => {
  it("records an added file with lifecycle metadata", () => {
    const changeSet = computeChangeSet(
      fileMap([]),
      fileMap([["facts/coffee.md", "h1", "User drinks oat milk lattes"]]),
    );

    expect(changeSet.changed).toBeTruthy();
    expect(changeSet.items).toHaveLength(1);
    expect(changeSet.items[0]).toMatchObject({
      filePath: "facts/coffee.md",
      diff: {
        format: "line",
        beforeExists: false,
        afterExists: true,
        truncated: false,
        stats: { added: 1, removed: 0 },
        hunks: [
          {
            beforeStartLine: null,
            afterStartLine: 1,
            lines: [
              {
                op: "add",
                beforeLine: null,
                afterLine: 1,
                text: "User drinks oat milk lattes",
              },
            ],
          },
        ],
      },
    });
  });

  it("records a removed file with lifecycle metadata", () => {
    const changeSet = computeChangeSet(
      fileMap([["facts/coffee.md", "h1", "User drinks oat milk lattes"]]),
      fileMap([]),
    );

    expect(changeSet.items).toHaveLength(1);
    expect(changeSet.items[0]).toMatchObject({
      filePath: "facts/coffee.md",
      diff: {
        format: "line",
        beforeExists: true,
        afterExists: false,
        truncated: false,
        stats: { added: 0, removed: 1 },
        hunks: [
          {
            beforeStartLine: 1,
            afterStartLine: null,
            lines: [
              {
                op: "remove",
                beforeLine: 1,
                afterLine: null,
                text: "User drinks oat milk lattes",
              },
            ],
          },
        ],
      },
    });
  });

  it("records a hash change as a modified file and ignores unchanged files", () => {
    const changeSet = computeChangeSet(
      fileMap([
        ["facts/coffee.md", "h1", "old"],
        ["facts/pets.md", "same", "Has a cat"],
      ]),
      fileMap([
        ["facts/coffee.md", "h2", "new"],
        ["facts/pets.md", "same", "Has a cat"],
      ]),
    );

    expect(changeSet.items).toHaveLength(1);
    expect(changeSet.items[0]).toMatchObject({
      filePath: "facts/coffee.md",
      diff: {
        format: "line",
        beforeExists: true,
        afterExists: true,
        truncated: false,
        stats: { added: 1, removed: 1 },
        hunks: [
          {
            beforeStartLine: 1,
            afterStartLine: 1,
            lines: [
              { op: "remove", beforeLine: 1, afterLine: null, text: "old" },
              { op: "add", beforeLine: null, afterLine: 1, text: "new" },
            ],
          },
        ],
      },
    });
  });

  it("does not parse frontmatter while computing diffs", () => {
    // Regression coverage: activity diffs should not parse memory file
    // frontmatter, so malformed YAML-like content cannot crash summarization.
    const content =
      "---\nname: zero search\ndescription: `zero search` command shipped in CLI v9.125.x\n---\nbody";
    expect(() => {
      return computeChangeSet(
        fileMap([]),
        fileMap([["facts/zero-search.md", "h1", content]]),
      );
    }).not.toThrow();

    const changeSet = computeChangeSet(
      fileMap([]),
      fileMap([["facts/zero-search.md", "h1", content]]),
    );
    expect(changeSet.items[0]).toMatchObject({
      filePath: "facts/zero-search.md",
      diff: {
        beforeExists: false,
        afterExists: true,
      },
    });
  });

  it("emits MEMORY.md alongside real file changes", () => {
    const changeSet = computeChangeSet(
      fileMap([["MEMORY.md", "idx1", "# index v1"]]),
      fileMap([
        ["MEMORY.md", "idx2", "# index v2"],
        ["facts/coffee.md", "h1", "User drinks oat milk lattes"],
      ]),
    );

    expect(
      changeSet.items.map((item) => {
        return item.filePath;
      }),
    ).toStrictEqual(["MEMORY.md", "facts/coffee.md"]);
  });

  it("emits MEMORY.md as its own item when it is the only changed file", () => {
    const changeSet = computeChangeSet(
      fileMap([["MEMORY.md", "idx1", "# index v1"]]),
      fileMap([["MEMORY.md", "idx2", "# index v2 reorganized"]]),
    );

    expect(changeSet.items).toHaveLength(1);
    expect(changeSet.items[0]).toMatchObject({
      filePath: "MEMORY.md",
      diff: {
        beforeExists: true,
        afterExists: true,
      },
    });
  });

  it("reports no change when both versions are identical", () => {
    const changeSet = computeChangeSet(
      fileMap([["facts/coffee.md", "h1", "x"]]),
      fileMap([["facts/coffee.md", "h1", "x"]]),
    );

    expect(changeSet.changed).toBeFalsy();
    expect(changeSet.items).toHaveLength(0);
  });
});
