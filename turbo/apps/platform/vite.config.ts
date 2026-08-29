import { fileURLToPath } from "node:url";

import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { devArtifactFetchProxy } from "./dev-artifact-fetch-proxy.ts";
import platformPackage from "./package.json";
import { clerkCoreHtmlPlugin } from "./scripts/clerk-html.ts";
import {
  applicationJavaScriptBundlePlugin,
  singleWorkerJavaScriptBundlePlugin,
} from "./scripts/single-bundle.ts";

process.env.VITE_APP_VERSION = platformPackage.version;

export default defineConfig({
  base: "/",
  envPrefix: ["VITE_", "PUBLIC_"],
  resolve: {
    alias: {
      "virtual:shared-database-worker": `${fileURLToPath(
        new URL("./src/shared-database-worker.ts", import.meta.url),
      )}?sharedworker`,
    },
  },
  worker: {
    plugins: () => {
      return [singleWorkerJavaScriptBundlePlugin()];
    },
  },
  plugins: [
    tailwindcss(),
    react(),
    devArtifactFetchProxy(),
    clerkCoreHtmlPlugin(),
    applicationJavaScriptBundlePlugin(),
    // Sentry source map upload (production builds only)
    process.env.SENTRY_AUTH_TOKEN &&
      sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        telemetry: false,
        sourcemaps: {
          // Delete source maps after upload to avoid exposing them
          filesToDeleteAfterUpload: ["./dist/**/*.map"],
        },
      }),
  ].filter(Boolean),
  server: {
    port: 3002,
    strictPort: true,
    host: true,
    allowedHosts: ["app.vm7.ai", "vm7.ai", "www.vm7.ai"],
  },
  build: {
    outDir: "dist",
    // Generate source maps for Sentry (uploaded and removed by plugin)
    sourcemap: !!process.env.SENTRY_AUTH_TOKEN,
    rolldownOptions: {
      output: {
        // Browser application modules are one deployment unit. The
        // SharedWorker is emitted and validated separately, while locale JSON
        // remains external and is fetched only for the active language.
        codeSplitting: false,
        // Mangle identifiers for smaller bundles while preserving runtime
        // function and class names for framework semantics and diagnostics.
        keepNames: true,
        minify: {
          compress: true,
          mangle: true,
          codegen: true,
        },
      },
    },
  },
});
