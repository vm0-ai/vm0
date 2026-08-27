import { describe, expect, it } from "vitest";

import { createStableChunkName } from "../stable-chunks.ts";

function chunkingContext(importersByModuleId: ReadonlyMap<string, string[]>) {
  return {
    getModuleInfo(moduleId: string) {
      const importers = importersByModuleId.get(moduleId);
      return importers === undefined ? null : { importers };
    },
  };
}

describe("stable chunk grouping", () => {
  it("groups only packages in the static startup graph", () => {
    const entryModuleId = "/repo/src/main.ts";
    const shellModuleId = "/repo/src/shell.ts";
    const lazyRouteModuleId = "/repo/src/routes/settings.ts";
    const foundationModuleId =
      "/repo/node_modules/.pnpm/react@19.2.6/node_modules/react/index.js";
    const authModuleId =
      "/repo/node_modules/.pnpm/@clerk+react@6.12.8/node_modules/@clerk/react/dist/index.js";
    const contentModuleId =
      "/repo/node_modules/.pnpm/@tiptap+core@3.21.0/node_modules/@tiptap/core/dist/index.js";
    const servicesModuleId =
      "/repo/node_modules/.pnpm/posthog-js@1.414.0/node_modules/posthog-js/dist/module.js";
    const lazyFoundationModuleId =
      "/repo/node_modules/.pnpm/lucide-react@1.30.0/node_modules/lucide-react/dist/lazy.js";
    const context = chunkingContext(
      new Map([
        [shellModuleId, [entryModuleId]],
        [lazyRouteModuleId, []],
        [foundationModuleId, [shellModuleId]],
        [authModuleId, [shellModuleId]],
        [contentModuleId, [shellModuleId]],
        [servicesModuleId, [shellModuleId]],
        [lazyFoundationModuleId, [lazyRouteModuleId]],
      ]),
    );
    const chunkName = createStableChunkName(entryModuleId);

    expect(chunkName(foundationModuleId, context)).toBe("vendor-foundation");
    expect(chunkName(authModuleId, context)).toBe("vendor-auth");
    expect(chunkName(contentModuleId, context)).toBe("vendor-content");
    expect(chunkName(servicesModuleId, context)).toBe("vendor-services");
    expect(chunkName(lazyFoundationModuleId, context)).toBeNull();
    expect(chunkName("/repo/src/feature.ts", context)).toBeNull();
  });

  it("normalizes paths and resolves cyclic importer graphs deterministically", () => {
    const entryModuleId = String.raw`C:\repo\src\main.ts`;
    const bridgeModuleId = String.raw`C:\repo\src\bridge.ts`;
    const foundationModuleId = String.raw`C:\repo\node_modules\.pnpm\react@19.2.6\node_modules\react\index.js`;
    const context = chunkingContext(
      new Map([
        [bridgeModuleId, [foundationModuleId, entryModuleId]],
        [foundationModuleId, [bridgeModuleId]],
      ]),
    );
    const reversedContext = chunkingContext(
      new Map([
        [bridgeModuleId, [entryModuleId, foundationModuleId]],
        [foundationModuleId, [bridgeModuleId]],
      ]),
    );
    const chunkName = createStableChunkName(entryModuleId);
    const reversedChunkName = createStableChunkName(entryModuleId);

    expect(chunkName(foundationModuleId, context)).toBe("vendor-foundation");
    expect(reversedChunkName(foundationModuleId, reversedContext)).toBe(
      "vendor-foundation",
    );
  });
});
