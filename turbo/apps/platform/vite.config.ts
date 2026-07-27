import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";
import { get as httpsGet } from "node:https";
import { defineConfig, type PluginOption } from "vite";

import platformPackage from "./package.json";

const DEV_ARTIFACT_FETCH_PROXY_PATH = "/__vm0-dev-artifact-fetch";
const DEV_ARTIFACT_FETCH_PROXY_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-length",
  "content-type",
  "etag",
] as const;
const FIREWALL_PERMISSION_DETAIL_METADATA_CHUNK_NAME_PREFIX =
  "vm0-firewall-permission-detail-metadata-";
const FIREWALL_PERMISSION_DETAIL_METADATA_CHUNK_PROTOCOL_VERSION = "v1";
const FIREWALL_PERMISSION_DETAIL_METADATA_MODULE_ID_RE =
  /\/packages\/connectors\/src\/firewall-metadata\/permission-details\/([a-z0-9][a-z0-9-]*)\.generated\.ts$/;
const FIREWALL_PERMISSION_DETAIL_METADATA_CHUNK_NAME_RE =
  /^vm0-firewall-permission-detail-metadata-([a-z0-9][a-z0-9-]*)\.generated$/;
const PLATFORM_MAIN_MODULE_ID_SUFFIX = "/apps/platform/src/main.ts";
const CLERK_AUTH_MODULE_ID_SUFFIXES = [
  "/@clerk/ui/dist/components/GoogleOneTap/index.js",
  "/@clerk/ui/dist/components/SignIn/index.js",
  "/@clerk/ui/dist/components/SignUp/index.js",
] as const;
const CLERK_WEB3_SOLANA_BUTTONS_IMPORT_SUFFIX =
  "/elements/Web3SolanaWalletButtons.js";
const DISABLED_CLERK_WEB3_SOLANA_MODULE_ID = "\0vm0-disabled-clerk-web3-solana";
const APP_INITIAL_CHUNK_NAME = "app-initial";
const CLERK_AUTH_CHUNK_NAME = "clerk-auth";
const MAX_COLD_START_JS_CSS_ASSETS = 10;
const appInitialStaticImportCache = new Map<string, boolean>();
const clerkAuthStaticImportCache = new Map<string, boolean>();

process.env.VITE_APP_VERSION = platformPackage.version;

function normalizedModuleId(id: string): string {
  const queryIndex = id.indexOf("?");
  const pathname = queryIndex === -1 ? id : id.slice(0, queryIndex);
  return pathname.replaceAll("\\", "/");
}

function isStaticallyImportedBy(
  moduleId: string,
  getModuleInfo: (id: string) => { importers: string[] } | null,
  rootModuleIdSuffixes: readonly string[],
  resultCache: Map<string, boolean>,
): boolean {
  const visitingModuleIds = new Set<string>();

  function visit(currentModuleId: string): boolean | null {
    const cachedResult = resultCache.get(currentModuleId);
    if (cachedResult !== undefined) {
      return cachedResult;
    }

    const normalizedId = normalizedModuleId(currentModuleId);
    if (rootModuleIdSuffixes.some((suffix) => normalizedId.endsWith(suffix))) {
      resultCache.set(currentModuleId, true);
      return true;
    }

    if (visitingModuleIds.has(currentModuleId)) {
      return null;
    }
    visitingModuleIds.add(currentModuleId);

    let foundCycle = false;
    const moduleInfo = getModuleInfo(currentModuleId);
    if (moduleInfo) {
      for (const importer of moduleInfo.importers) {
        const importerResult = visit(importer);
        if (importerResult === true) {
          visitingModuleIds.delete(currentModuleId);
          resultCache.set(currentModuleId, true);
          return true;
        }
        if (importerResult === null) {
          foundCycle = true;
        }
      }
    }

    visitingModuleIds.delete(currentModuleId);
    if (foundCycle) {
      return null;
    }
    resultCache.set(currentModuleId, false);
    return false;
  }

  return visit(moduleId) === true;
}

function clerkBundlePolicy(): PluginOption {
  let replacedWeb3SolanaModule = false;

  return {
    name: "vm0-clerk-bundle-policy",
    enforce: "pre",
    buildStart() {
      replacedWeb3SolanaModule = false;
      appInitialStaticImportCache.clear();
      clerkAuthStaticImportCache.clear();
    },
    resolveId: {
      filter: {
        id: /Web3SolanaWalletButtons\.js$/,
      },
      handler(source, importer) {
        if (
          importer?.includes("/@clerk/ui/") &&
          normalizedModuleId(source).endsWith(
            CLERK_WEB3_SOLANA_BUTTONS_IMPORT_SUFFIX,
          )
        ) {
          replacedWeb3SolanaModule = true;
          return DISABLED_CLERK_WEB3_SOLANA_MODULE_ID;
        }
        return null;
      },
    },
    load(id) {
      if (id !== DISABLED_CLERK_WEB3_SOLANA_MODULE_ID) {
        return null;
      }
      return [
        "export function Web3SolanaWalletButtons() {",
        '  throw new Error("Web3/Solana authentication is disabled in vm0.");',
        "}",
      ].join("\n");
    },
    generateBundle(_options, bundle) {
      if (!replacedWeb3SolanaModule) {
        this.error(
          "Clerk no longer imports the expected Web3/Solana module. Update the bundle policy before upgrading Clerk.",
        );
      }

      const chunks = Object.values(bundle).filter(
        (output) => output.type === "chunk",
      );
      for (const chunk of chunks) {
        if (
          Object.keys(chunk.modules).some((moduleId) =>
            normalizedModuleId(moduleId).includes("/node_modules/@solana/"),
          )
        ) {
          this.error(
            `Unexpected Solana module emitted in ${chunk.fileName}. vm0 does not support Web3/Solana authentication.`,
          );
        }
      }

      const mainChunk = chunks.find(
        (chunk) =>
          chunk.isEntry ||
          normalizedModuleId(chunk.facadeModuleId ?? "").endsWith(
            PLATFORM_MAIN_MODULE_ID_SUFFIX,
          ),
      );
      const appInitialChunk = chunks.find(
        (chunk) => chunk.name === APP_INITIAL_CHUNK_NAME,
      );
      const clerkAuthChunk = chunks.find(
        (chunk) => chunk.name === CLERK_AUTH_CHUNK_NAME,
      );
      if (!mainChunk || !appInitialChunk || !clerkAuthChunk) {
        this.error(
          [
            "Expected main, app-initial, and clerk-auth chunks when checking the cold-start bundle budget.",
            `Emitted chunks: ${chunks
              .map((chunk) => chunk.name)
              .sort()
              .join(", ")}`,
          ].join("\n"),
        );
      }

      const coldStartChunkFiles = new Set<string>();
      const coldStartCssFiles = new Set<string>();
      const pendingChunkFiles = [
        mainChunk.fileName,
        appInitialChunk.fileName,
        clerkAuthChunk.fileName,
      ];

      while (pendingChunkFiles.length > 0) {
        const fileName = pendingChunkFiles.pop();
        if (!fileName || coldStartChunkFiles.has(fileName)) {
          continue;
        }

        const output = bundle[fileName];
        if (!output || output.type !== "chunk") {
          continue;
        }

        coldStartChunkFiles.add(fileName);
        for (const cssFile of output.viteMetadata?.importedCss ?? []) {
          coldStartCssFiles.add(cssFile);
        }
        pendingChunkFiles.push(...output.imports);
      }

      const coldStartAssetCount =
        coldStartChunkFiles.size + coldStartCssFiles.size;
      if (coldStartAssetCount > MAX_COLD_START_JS_CSS_ASSETS) {
        this.error(
          [
            `Clerk cold start emits ${coldStartAssetCount} JS/CSS assets; the limit is ${MAX_COLD_START_JS_CSS_ASSETS}.`,
            `JS: ${[...coldStartChunkFiles].sort().join(", ")}`,
            `CSS: ${[...coldStartCssFiles].sort().join(", ")}`,
          ].join("\n"),
        );
      }

      this.info(
        `Clerk cold-start bundle: ${coldStartChunkFiles.size} JS + ${coldStartCssFiles.size} CSS assets.`,
      );
    },
  };
}

function firewallPermissionDetailMetadataChunkName(
  moduleId: string,
): string | null {
  const match = FIREWALL_PERMISSION_DETAIL_METADATA_MODULE_ID_RE.exec(
    normalizedModuleId(moduleId),
  );
  if (!match) {
    return null;
  }
  return `${FIREWALL_PERMISSION_DETAIL_METADATA_CHUNK_NAME_PREFIX}${match[1]}.generated`;
}

function firewallPermissionDetailMetadataChunkFileName(
  chunkName: string,
): string | null {
  const match =
    FIREWALL_PERMISSION_DETAIL_METADATA_CHUNK_NAME_RE.exec(chunkName);
  if (!match) {
    return null;
  }
  return `firewall-metadata/permission-details/${FIREWALL_PERMISSION_DETAIL_METADATA_CHUNK_PROTOCOL_VERSION}/${match[1]}.generated.js`;
}

function stableGeneratedFirewallChunkName(moduleId: string): string | null {
  return firewallPermissionDetailMetadataChunkName(moduleId);
}

function stableGeneratedFirewallChunkFileName(
  chunkName: string,
): string | null {
  return firewallPermissionDetailMetadataChunkFileName(chunkName);
}

function isAllowedDevArtifactFetchUrl(url: URL): boolean {
  if (url.protocol !== "https:") {
    return false;
  }
  return (
    url.hostname === "cdn.vm0.io" ||
    url.hostname === "cdn.vm7.io" ||
    url.hostname.endsWith(".sites.vm0.io") ||
    url.hostname.endsWith(".sites.vm7.io")
  );
}

function sendBadGateway(res: ServerResponse): void {
  res.statusCode = 502;
  res.end("Bad gateway");
}

function handleDevArtifactFetchProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }

  try {
    const requestUrl = new URL(req.url ?? "", "http://localhost");
    const rawTarget = requestUrl.searchParams.get("url");
    if (!rawTarget) {
      res.statusCode = 400;
      res.end("Missing url");
      return;
    }

    if (!URL.canParse(rawTarget)) {
      res.statusCode = 400;
      res.end("Invalid url");
      return;
    }

    const target = new URL(rawTarget);
    if (!isAllowedDevArtifactFetchUrl(target)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const upstreamRequest = httpsGet(target, (upstream) => {
      res.statusCode = upstream.statusCode ?? 502;
      for (const header of DEV_ARTIFACT_FETCH_PROXY_HEADERS) {
        const value = upstream.headers[header];
        if (value) {
          res.setHeader(header, value);
        }
      }
      upstream.pipe(res);
    });
    upstreamRequest.on("error", () => {
      sendBadGateway(res);
    });
  } catch {
    sendBadGateway(res);
  }
}

function devArtifactFetchProxy(): PluginOption {
  return {
    name: "vm0-dev-artifact-fetch-proxy",
    configureServer(server) {
      server.middlewares.use(DEV_ARTIFACT_FETCH_PROXY_PATH, (req, res) => {
        handleDevArtifactFetchProxyRequest(req, res);
      });
    },
  };
}

export default defineConfig({
  base: "/",
  envPrefix: ["VITE_", "PUBLIC_"],
  plugins: [
    clerkBundlePolicy(),
    tailwindcss(),
    react(),
    devArtifactFetchProxy(),
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
      preserveEntrySignatures: false,
      output: {
        strictExecutionOrder: true,
        // Stable generated firewall chunk URLs must also keep stable import contracts.
        minifyInternalExports: false,
        // Open-source project: compress and strip whitespace, but keep
        // original identifiers readable (no name mangling).
        minify: {
          compress: true,
          mangle: false,
          codegen: true,
        },
        chunkFileNames(chunkInfo) {
          return (
            stableGeneratedFirewallChunkFileName(chunkInfo.name) ??
            "assets/[name]-[hash].js"
          );
        },
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            {
              name(moduleId) {
                return stableGeneratedFirewallChunkName(moduleId);
              },
              test(moduleId) {
                return stableGeneratedFirewallChunkName(moduleId) !== null;
              },
              priority: 200,
            },
            {
              name(moduleId, context) {
                if (moduleId === DISABLED_CLERK_WEB3_SOLANA_MODULE_ID) {
                  return null;
                }
                return isStaticallyImportedBy(
                  moduleId,
                  (id) => context.getModuleInfo(id),
                  [PLATFORM_MAIN_MODULE_ID_SUFFIX],
                  appInitialStaticImportCache,
                )
                  ? APP_INITIAL_CHUNK_NAME
                  : null;
              },
              priority: 100,
            },
            {
              name(moduleId, context) {
                if (moduleId === DISABLED_CLERK_WEB3_SOLANA_MODULE_ID) {
                  return CLERK_AUTH_CHUNK_NAME;
                }
                return isStaticallyImportedBy(
                  moduleId,
                  (id) => context.getModuleInfo(id),
                  CLERK_AUTH_MODULE_ID_SUFFIXES,
                  clerkAuthStaticImportCache,
                )
                  ? CLERK_AUTH_CHUNK_NAME
                  : null;
              },
              priority: 90,
            },
          ],
        },
      },
    },
  },
});
