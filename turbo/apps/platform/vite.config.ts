import { fileURLToPath } from "node:url";

import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { devArtifactFetchProxy } from "./dev-artifact-fetch-proxy.ts";
import platformPackage from "./package.json";
import { applicationResourcePriorityHtmlPlugin } from "./scripts/app-resource-priority-html.ts";
import { clerkCoreHtmlPlugin } from "./scripts/clerk-html.ts";
import {
  APPLICATION_LAZY_CHUNK,
  applicationJavaScriptBundlePlugin,
  isVendorModule,
  singleWorkerJavaScriptBundlePlugin,
} from "./scripts/single-bundle.ts";
import { workerDomGlobalsPlugin } from "./scripts/worker-dom-globals.ts";

const APP_ASSET_BASE = "https://static.okou.io/okou-app/";
const APP_GIT_COMMIT_SHA = process.env.OKOU_APP_GIT_COMMIT_SHA ?? "";
const APP_VERSION = process.env.OKOU_APP_VERSION ?? platformPackage.version;

const runtimeBuildInfoHtmlPlugin = {
  name: "platform-runtime-build-info-html",
  transformIndexHtml() {
    return [
      {
        tag: "meta",
        attrs: {
          name: "okou-app-git-commit-sha",
          content: APP_GIT_COMMIT_SHA,
        },
        injectTo: "head-prepend",
      },
      {
        tag: "meta",
        attrs: { name: "okou-app-version", content: APP_VERSION },
        injectTo: "head-prepend",
      },
    ];
  },
} satisfies Plugin;

export default defineConfig(({ command }) => ({
  base: command === "build" ? APP_ASSET_BASE : "/",
  define: {
    __OKOU_APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  experimental: {
    renderBuiltUrl(filename, { hostType, type }) {
      if (
        hostType === "js" &&
        type === "asset" &&
        /^assets\/shared-database-worker-[^/]+\.js$/u.test(filename)
      ) {
        const workerPath = new URL(filename, APP_ASSET_BASE).pathname;
        return { runtime: `location.origin + ${JSON.stringify(workerPath)}` };
      }
    },
  },
  envPrefix: ["VITE_", "PUBLIC_"],
  resolve: {
    alias: {
      "virtual:shared-database-worker": `${fileURLToPath(
        new URL("./src/shared-database-worker.ts", import.meta.url),
      )}?sharedworker&url`,
    },
  },
  worker: {
    plugins: () => {
      return [workerDomGlobalsPlugin(), singleWorkerJavaScriptBundlePlugin()];
    },
  },
  plugins: [
    tailwindcss(),
    react(),
    devArtifactFetchProxy(),
    clerkCoreHtmlPlugin(),
    runtimeBuildInfoHtmlPlugin,
    applicationJavaScriptBundlePlugin(),
    applicationResourcePriorityHtmlPlugin(),
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
        // Keep the optional KaTeX runtime in its own lazy chunk. All other
        // third-party modules and the pinned generated Mermaid package remain
        // in one cache-stable eager vendor chunk.
        codeSplitting: {
          groups: [
            {
              name: APPLICATION_LAZY_CHUNK.name,
              test: APPLICATION_LAZY_CHUNK.modulePattern,
            },
            {
              name: "vendor",
              test: isVendorModule,
            },
          ],
        },
      },
    },
  },
}));
