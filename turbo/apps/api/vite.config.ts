import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import build from "@hono/vite-build/vercel";
import { nodeFileTrace } from "@vercel/nft";
import { defineConfig, type Plugin } from "vite";

import vercelConfig from "./vercel.json";

// `pg` and the OTel instrumentation chain must stay out of the bundle: the
// single-file ESM bundle has no module boundary for the import hook to
// intercept, so `@opentelemetry/instrumentation-pg` could not patch a bundled
// `pg`. Kept external, the `import 'pg'` boundary survives and the ESM loader
// hook registered in `instrument.ts` patches it. The instrumentation packages
// and `import-in-the-middle` are external too so a single shared instance backs
// both the loader hook and the registered patch.
const EXTERNAL_RUNTIME_DEPS = [
  "pg",
  "@opentelemetry/instrumentation",
  "@opentelemetry/instrumentation-pg",
];

// Vercel Build Output API functions are self-contained and get no dependency
// install, so the externalized deps must be physically placed in the function.
// Trace them (plus the ESM hook entry) with @vercel/nft and copy the closure
// into the function's node_modules. The tree is flattened — each file is keyed
// by its package-relative path after the last `node_modules/` segment — because
// pnpm's nested symlinked store can't be reproduced inside the `.func`.
function bundleExternalDepsIntoFunc(): Plugin {
  return {
    name: "bundle-external-deps-into-func",
    apply: "build",
    async closeBundle() {
      const funcDir = resolve(
        import.meta.dirname,
        ".vercel/output/functions/__hono.func",
      );
      const entry = join(funcDir, "index.js");
      if (!existsSync(entry)) {
        return;
      }

      // Trace from the externalized packages' own entry points (not the
      // bundled function, which would drag in the whole dependency graph).
      const require = createRequire(import.meta.url);
      const traceEntries = [
        ...EXTERNAL_RUNTIME_DEPS.map((dep) => require.resolve(dep)),
        require.resolve("@opentelemetry/instrumentation/hook.mjs"),
      ];
      const base = resolve(import.meta.dirname, "../..");

      const { fileList } = await nodeFileTrace(traceEntries, { base });

      const marker = "node_modules/";
      for (const rel of fileList) {
        const idx = rel.lastIndexOf(marker);
        if (idx === -1) {
          continue;
        }
        const dest = join(funcDir, "node_modules", rel.slice(idx + marker.length));
        await mkdir(dirname(dest), { recursive: true });
        await cp(resolve(base, rel), dest, { dereference: true, recursive: true });
      }
    },
  };
}

export default defineConfig({
  build: {
    copyPublicDir: false,
    rollupOptions: {
      output: {
        // Vercel only packages files inside the .func directory for a function.
        codeSplitting: false,
      },
    },
  },
  plugins: [
    build({
      emptyOutDir: true,
      entry: "./src/index.ts",
      external: EXTERNAL_RUNTIME_DEPS,
      vercel: {
        config: {
          crons: vercelConfig.crons,
        },
      },
    }),
    bundleExternalDepsIntoFunc(),
  ],
});
