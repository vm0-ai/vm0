import build from "@hono/vite-build/vercel";
import { defineConfig } from "vite";

import { connectorCatalogValidationRevision } from "./src/build-config/connector-catalog-validation-revision";
import vercelConfig from "./vercel.json";

export default defineConfig({
  define: {
    __CONNECTOR_CATALOG_VALIDATION_REVISION__: JSON.stringify(
      connectorCatalogValidationRevision(),
    ),
  },
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
      // @hono/vite-build still emits the Vercel adapter removed in
      // @hono/node-server v2. Keep that build-only adapter on v1 while the
      // long-lived server runtime uses v2.
      entryContentAfterHooks: [
        () => {
          return "import { handle } from '@hono/node-server-v1/vercel'";
        },
      ],
      vercel: {
        config: {
          crons: vercelConfig.crons,
        },
      },
    }),
  ],
});
