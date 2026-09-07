import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const okouSymbolSvg = readFileSync(
  new URL("./okou-symbol-light.svg", import.meta.url),
  "utf8",
);

describe("Okou desktop symbol", () => {
  it("ships without a background rectangle", () => {
    expect(okouSymbolSvg).not.toContain("<rect");
  });
});
