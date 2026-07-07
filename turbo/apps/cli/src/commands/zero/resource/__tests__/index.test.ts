import { describe, expect, it } from "vitest";

import { findRegistryResourceForPull } from "../index";

describe("zero resource pull registry resolver", () => {
  it("resolves a presentation color system archive", () => {
    expect(findRegistryResourceForPull("color-system:carnival")).toEqual(
      expect.objectContaining({
        id: "color-system:carnival",
        kind: "color-system",
        source: expect.objectContaining({
          path: "presentation-color-system/carnival",
          archive: expect.objectContaining({ type: "tar.gz" }),
        }),
      }),
    );
  });

  it("canonicalizes unprefixed presentation color system ids", () => {
    expect(findRegistryResourceForPull("carnival")?.id).toBe(
      "color-system:carnival",
    );
  });

  it("resolves a built-in website template package archive", () => {
    expect(findRegistryResourceForPull("template:warm-cards")).toEqual(
      expect.objectContaining({
        id: "template:warm-cards",
        kind: "template",
        targets: ["website"],
        source: expect.objectContaining({
          path: "warm-cards",
          archive: expect.objectContaining({
            type: "tar.gz",
            sha256:
              "1fafd9e5541dfe53ffdfafcbb6e45d525328c9a0cc5bb4afb2a06b4685e153d2",
          }),
        }),
      }),
    );
  });

  it("canonicalizes unprefixed built-in website template ids", () => {
    expect(findRegistryResourceForPull("warm-cards")?.id).toBe(
      "template:warm-cards",
    );
  });
});
