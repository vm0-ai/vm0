import { WEBSITE_TEMPLATE_ITEMS } from "@vm0/core";
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
    expect(findRegistryResourceForPull("template:dot-matrix")).toEqual(
      expect.objectContaining({
        id: "template:dot-matrix",
        kind: "template",
        targets: ["website"],
        source: expect.objectContaining({
          path: "dot-matrix",
          archive: expect.objectContaining({
            type: "tar.gz",
            sha256:
              "f489a51fb99d8fadff8712d0406df06ac1a530116ebe612ab3f8605daa2bcce2",
          }),
        }),
      }),
    );
  });

  it("canonicalizes unprefixed built-in website template ids", () => {
    expect(findRegistryResourceForPull("dot-matrix")?.id).toBe(
      "template:dot-matrix",
    );
  });

  it("resolves every feature-switched website v2 package", () => {
    for (const item of WEBSITE_TEMPLATE_ITEMS) {
      const resourceId = `${item.resourceId}-v2`;

      expect(findRegistryResourceForPull(resourceId)).toEqual(
        expect.objectContaining({
          id: resourceId,
          kind: "template",
          targets: ["website"],
          source: expect.objectContaining({
            path: item.sourcePath,
            archive: {
              type: "tar.gz",
              sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
          }),
        }),
      );
    }
  });
});
