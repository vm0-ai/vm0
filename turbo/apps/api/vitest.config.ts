import { defineConfig } from "vitest/config";

import { connectorCatalogValidationRevision } from "./src/build-config/connector-catalog-validation-revision";

export default defineConfig({
  define: {
    __CONNECTOR_CATALOG_VALIDATION_REVISION__: JSON.stringify(
      connectorCatalogValidationRevision(),
    ),
  },
  test: {
    globals: true,
    environment: "node",
    env: {
      TZ: "UTC",
    },
    setupFiles: ["./src/__tests__/env-stub.ts", "./src/__tests__/setup.ts"],
    exclude: ["node_modules/**", "dist/**", "**/__benches__/**"],
    benchmark: {
      include: ["src/**/__benches__/**/*.bench.ts"],
      includeSamples: true,
      reporters: ["default", "./scripts/bench-p90-reporter.ts"],
    },
  },
});
