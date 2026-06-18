import { describe, expect, it } from "vitest";

import { findRegistryResourceForPull } from "../index";

describe("zero resource pull registry resolver", () => {
  it("resolves presentation runtime tools", () => {
    expect(findRegistryResourceForPull("tool:presentation-deck-tools")).toEqual(
      expect.objectContaining({
        id: "tool:presentation-deck-tools",
        kind: "tool",
        source: expect.objectContaining({
          path: "presentation-runtime/html-ppt-deck-tools",
          archive: expect.objectContaining({ type: "tar.gz" }),
        }),
      }),
    );
  });

  it("canonicalizes unprefixed presentation runtime tool ids", () => {
    expect(findRegistryResourceForPull("presentation-deck-tools")?.id).toBe(
      "tool:presentation-deck-tools",
    );
  });
});
