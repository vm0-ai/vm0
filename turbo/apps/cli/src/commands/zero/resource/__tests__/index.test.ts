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
    expect(findRegistryResourceForPull("template:black-slabs")).toEqual(
      expect.objectContaining({
        id: "template:black-slabs",
        kind: "template",
        targets: ["website"],
        source: expect.objectContaining({
          path: "black-slabs",
          archive: expect.objectContaining({
            type: "tar.gz",
            sha256:
              "8f30984e444283bf0322106a1099623346e153bc11d26e3044fbf61ef43514c3",
          }),
        }),
      }),
    );
  });

  it("canonicalizes unprefixed built-in website template ids", () => {
    expect(findRegistryResourceForPull("black-slabs")?.id).toBe(
      "template:black-slabs",
    );
  });
});
