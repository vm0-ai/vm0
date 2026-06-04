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
  it("classifies an added file as learned", () => {
    const changeSet = computeChangeSet(
      fileMap([]),
      fileMap([["facts/coffee.md", "h1", "User drinks oat milk lattes"]]),
    );

    expect(changeSet.changed).toBeTruthy();
    expect(changeSet.items).toHaveLength(1);
    expect(changeSet.items[0]).toMatchObject({
      kind: "learned",
      filePath: "facts/coffee.md",
      diff: {
        format: "line",
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

  it("classifies a removed file as forgotten", () => {
    const changeSet = computeChangeSet(
      fileMap([["facts/coffee.md", "h1", "User drinks oat milk lattes"]]),
      fileMap([]),
    );

    expect(changeSet.items).toHaveLength(1);
    expect(changeSet.items[0]).toMatchObject({
      kind: "forgotten",
      filePath: "facts/coffee.md",
      diff: {
        format: "line",
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

  it("classifies a hash change as updated and ignores unchanged files", () => {
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
      kind: "updated",
      filePath: "facts/coffee.md",
      diff: {
        format: "line",
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

  it("derives title and description from markdown frontmatter", () => {
    const content =
      "---\nname: Coffee preference\ndescription: User prefers oat milk lattes\n---\nbody";
    const changeSet = computeChangeSet(
      fileMap([]),
      fileMap([["facts/coffee.md", "h1", content]]),
    );

    expect(changeSet.items[0]).toMatchObject({
      title: "Coffee preference",
      description: "User prefers oat milk lattes",
    });
  });

  it("falls back to the file path as title when there is no frontmatter", () => {
    const changeSet = computeChangeSet(
      fileMap([]),
      fileMap([["notes/raw.txt", "h1", "freeform note"]]),
    );

    expect(changeSet.items[0]).toMatchObject({
      title: "notes/raw.txt",
      description: null,
    });
  });

  it("falls back to the file path when frontmatter is not valid YAML", () => {
    // Regression for the prod crash: a memory file whose `description` value
    // opens with a backtick is a reserved YAML scalar char and makes
    // parseSkillFrontmatter throw a YAMLParseError. The diff must degrade to a
    // path-based title instead of letting the whole summary run 500.
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
      kind: "learned",
      title: "facts/zero-search.md",
      description: null,
    });
  });

  it("folds MEMORY.md churn into real file changes (does not emit it)", () => {
    const changeSet = computeChangeSet(
      fileMap([["MEMORY.md", "idx1", "# index v1"]]),
      fileMap([
        ["MEMORY.md", "idx2", "# index v2"],
        ["facts/coffee.md", "h1", "User drinks oat milk lattes"],
      ]),
    );

    expect(changeSet.items).toHaveLength(1);
    expect(changeSet.items[0]?.filePath).toBe("facts/coffee.md");
  });

  it("emits MEMORY.md as its own item when no real file change explains it", () => {
    const changeSet = computeChangeSet(
      fileMap([["MEMORY.md", "idx1", "# index v1"]]),
      fileMap([["MEMORY.md", "idx2", "# index v2 reorganized"]]),
    );

    expect(changeSet.items).toHaveLength(1);
    expect(changeSet.items[0]).toMatchObject({
      kind: "updated",
      filePath: "MEMORY.md",
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
