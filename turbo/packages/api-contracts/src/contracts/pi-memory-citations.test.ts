import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PI_MEMORY_CITATION_CLOSE,
  PI_MEMORY_CITATION_LIMITS,
  PI_MEMORY_CITATION_OPEN,
  PiMemoryCitationStreamParser,
  projectPiMemoryCitationSegments,
  projectPiMemoryCitationText,
  parsePiMemoryCitation,
} from "./pi-memory-citations";

interface Fixture {
  readonly cases: readonly {
    readonly name: string;
    readonly chunks: readonly string[];
    readonly visibleText: string;
    readonly entries: readonly unknown[];
    readonly rolloutIds: readonly string[];
  }[];
}

const fixturePath = fileURLToPath(
  new URL("../../../../../fixtures/pi-memory-citations.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

function parseChunks(chunks: readonly string[]) {
  const parser = new PiMemoryCitationStreamParser();
  for (const chunk of chunks) {
    parser.push(chunk);
  }
  return parser.finish();
}

describe("Pi memory citations", () => {
  for (const fixtureCase of fixture.cases) {
    it(`matches the shared fixture: ${fixtureCase.name}`, () => {
      const result = parseChunks(fixtureCase.chunks);
      expect(result.visibleText).toBe(fixtureCase.visibleText);
      expect(result.citation?.entries ?? []).toEqual(fixtureCase.entries);
      expect(result.citation?.rolloutIds ?? []).toEqual(fixtureCase.rolloutIds);
    });
  }

  it.each([PI_MEMORY_CITATION_OPEN, PI_MEMORY_CITATION_CLOSE])(
    "handles every split point in %s",
    (delimiter) => {
      const envelope = `${PI_MEMORY_CITATION_OPEN}<citation_entries>x:1-1|note=[n]</citation_entries>${PI_MEMORY_CITATION_CLOSE}`;
      for (let index = 1; index < delimiter.length; index += 1) {
        const boundary = envelope.indexOf(delimiter) + index;
        const result = parseChunks([
          `before${envelope.slice(0, boundary)}`,
          `${envelope.slice(boundary)}after`,
        ]);
        expect(result.visibleText).toBe("beforeafter");
        expect(result.citation?.entries).toHaveLength(1);
      }
    },
  );

  it("retains segment placement around non-text blocks", () => {
    const result = projectPiMemoryCitationSegments([
      "before<oai-mem-cit",
      "ation><citation_entries>x:1-1|note=[n]</citation_entries></oai-mem-citation>after",
    ]);
    expect(result.visibleSegments).toEqual(["before", "after"]);
  });

  it("bounds oversized bodies without exposing them", () => {
    const text = `${PI_MEMORY_CITATION_OPEN}${"界".repeat(PI_MEMORY_CITATION_LIMITS.bodyBytes)}${PI_MEMORY_CITATION_CLOSE}ok`;
    const result = projectPiMemoryCitationText(text);
    expect(result.visibleText).toBe("ok");
    expect(result.citation).toBeUndefined();
    expect(result.diagnostics.oversizedBodies).toBe(1);
  });

  it("bounds entry counts, field bytes, and structured metadata", () => {
    const validEntries = Array.from({ length: 65 }, (_, index) => {
      return `p${index}:1-1|note=[n]`;
    }).join("\n");
    const text = `${PI_MEMORY_CITATION_OPEN}<citation_entries>${validEntries}\n${"界".repeat(342)}:1-1|note=[n]\nx:1-1|note=[${"界".repeat(683)}]</citation_entries>${PI_MEMORY_CITATION_CLOSE}`;
    const result = projectPiMemoryCitationText(text);
    expect(result.citation?.entries).toHaveLength(
      PI_MEMORY_CITATION_LIMITS.entries,
    );
    expect(result.diagnostics.invalidEntries).toBe(3);

    expect(
      parsePiMemoryCitation({
        entries: Array.from({ length: 65 }, (_, index) => {
          return { path: `p${index}`, lineStart: 1, lineEnd: 1, note: "n" };
        }),
        rolloutIds: [],
      })?.entries,
    ).toHaveLength(PI_MEMORY_CITATION_LIMITS.entries);
  });
});
