import type { Plugin } from "vite";

export const RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES = 8_500_000;

const SHARED_DATABASE_WORKER_FILE_PATTERN =
  /^assets\/shared-database-worker-[^/]+\.js$/u;
const VENDOR_FILE_PATTERN = /^assets\/vendor-[^/]+\.js$/u;
const ROLLDOWN_RUNTIME_FILE_PATTERN = /^assets\/rolldown-runtime-[^/]+\.js$/u;

const FORBIDDEN_BUNDLED_PACKAGES = [
  "@base-org",
  "@clerk/clerk-js",
  "@clerk/ui",
  "@coinbase",
  "@solana",
  "@wallet-standard",
  "katex",
  "rehype-katex",
  "remark-math",
  "tr46",
] as const;

const FORBIDDEN_PRISM_MODULES = [
  {
    modulePath: "/node_modules/rehype-prism-plus/dist/index.es.js",
    name: "rehype-prism-plus (root entry)",
  },
  {
    modulePath: "/node_modules/rehype-prism-plus/dist/all.es.js",
    name: "rehype-prism-plus/all",
  },
  {
    modulePath: "/node_modules/rehype-prism-plus/dist/generator.es.js",
    name: "rehype-prism-plus/generator",
  },
  {
    modulePath: "/node_modules/refractor/lib/all.js",
    name: "refractor/all",
  },
] as const;

const FORBIDDEN_SERVER_CONTRACT_MODULES = [
  "/packages/api-contracts/src/contracts/runners.ts",
  "/packages/api-contracts/src/contracts/webhooks.ts",
] as const;

interface GeneratedChunk {
  readonly code: string;
  readonly dynamicImports?: readonly string[];
  readonly fileName: string;
  readonly imports?: readonly string[];
  readonly isEntry?: boolean;
  readonly moduleIds?: readonly string[];
  readonly type: "chunk";
}

interface GeneratedAsset {
  readonly fileName: string;
  readonly source: string | Uint8Array;
  readonly type: "asset";
}

type GeneratedOutput = GeneratedAsset | GeneratedChunk;

function normalizeModuleId(moduleId: string): string {
  return moduleId.replaceAll("\\", "/");
}

function isNodeModule(moduleId: string): boolean {
  return normalizeModuleId(moduleId).includes("/node_modules/");
}

function bundledPackage(moduleId: string): string | undefined {
  const normalized = normalizeModuleId(moduleId);
  return FORBIDDEN_BUNDLED_PACKAGES.find((packageName) => {
    return normalized.includes(`/node_modules/${packageName}/`);
  });
}

function forbiddenPrismModule(moduleId: string): string | undefined {
  const normalized = normalizeModuleId(moduleId);
  return FORBIDDEN_PRISM_MODULES.find(({ modulePath }) => {
    return normalized.includes(modulePath);
  })?.name;
}

function forbiddenServerContractModule(moduleId: string): string | undefined {
  const normalized = normalizeModuleId(moduleId);
  return FORBIDDEN_SERVER_CONTRACT_MODULES.find((modulePath) => {
    return normalized.endsWith(modulePath);
  });
}

function generatedChunks(
  outputs: readonly GeneratedOutput[],
): GeneratedChunk[] {
  return outputs.filter((output): output is GeneratedChunk => {
    return output.type === "chunk";
  });
}

function outputDescription(outputs: readonly GeneratedOutput[]): string {
  if (outputs.length === 0) {
    return "none";
  }
  return outputs
    .map((output) => {
      return `${output.fileName} (${output.type})`;
    })
    .join(", ");
}

function chunkViolations(
  chunk: GeneratedChunk,
  allowedStaticImports: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  const unexpectedImports = (chunk.imports ?? []).filter((fileName) => {
    return !allowedStaticImports.has(fileName);
  });
  if (unexpectedImports.length > 0) {
    violations.push(
      `${chunk.fileName}: unexpected JavaScript imports: ${unexpectedImports.join(", ")}`,
    );
  }
  if ((chunk.dynamicImports ?? []).length > 0) {
    violations.push(
      `${chunk.fileName}: expected no dynamic JavaScript imports, found ${(chunk.dynamicImports ?? []).join(", ")}`,
    );
  }

  const forbiddenPackages = new Set(
    (chunk.moduleIds ?? [])
      .map(bundledPackage)
      .filter((packageName): packageName is string => {
        return packageName !== undefined;
      }),
  );
  if (forbiddenPackages.size > 0) {
    violations.push(
      `${chunk.fileName}: forbidden packages reached the bundle: ${[...forbiddenPackages].join(", ")}`,
    );
  }
  const forbiddenPrismModules = new Set(
    (chunk.moduleIds ?? [])
      .map(forbiddenPrismModule)
      .filter((moduleName): moduleName is string => {
        return moduleName !== undefined;
      }),
  );
  if (forbiddenPrismModules.size > 0) {
    violations.push(
      `${chunk.fileName}: forbidden non-common Prism modules reached the bundle: ${[...forbiddenPrismModules].join(", ")}`,
    );
  }
  const forbiddenServerContractModules = new Set(
    (chunk.moduleIds ?? [])
      .map(forbiddenServerContractModule)
      .filter((modulePath): modulePath is string => {
        return modulePath !== undefined;
      }),
  );
  if (forbiddenServerContractModules.size > 0) {
    violations.push(
      `${chunk.fileName}: server-only API contract modules reached the eager platform graph: ${[...forbiddenServerContractModules].join(", ")}`,
    );
  }
  return violations;
}

export function applicationBundleViolations(
  outputs: readonly GeneratedOutput[],
): string[] {
  const javaScriptOutputs = outputs.filter((output) => {
    return output.fileName.endsWith(".js");
  });
  const applicationChunks = generatedChunks(javaScriptOutputs);
  const workerAssets = javaScriptOutputs.filter(
    (output): output is GeneratedAsset => {
      return (
        output.type === "asset" &&
        SHARED_DATABASE_WORKER_FILE_PATTERN.test(output.fileName)
      );
    },
  );
  const vendorChunks = applicationChunks.filter((chunk) => {
    return VENDOR_FILE_PATTERN.test(chunk.fileName);
  });
  const runtimeChunks = applicationChunks.filter((chunk) => {
    return ROLLDOWN_RUNTIME_FILE_PATTERN.test(chunk.fileName);
  });
  const appChunks = applicationChunks.filter((chunk) => {
    return (
      !VENDOR_FILE_PATTERN.test(chunk.fileName) &&
      !ROLLDOWN_RUNTIME_FILE_PATTERN.test(chunk.fileName)
    );
  });
  const appChunk = appChunks[0];
  const vendorChunk = vendorChunks[0];
  const runtimeChunk = runtimeChunks[0];
  const workerAsset = workerAssets[0];
  if (
    javaScriptOutputs.length !== 4 ||
    applicationChunks.length !== 3 ||
    appChunks.length !== 1 ||
    vendorChunks.length !== 1 ||
    runtimeChunks.length !== 1 ||
    workerAssets.length !== 1 ||
    !appChunk ||
    !vendorChunk ||
    !runtimeChunk ||
    !workerAsset ||
    appChunk.isEntry !== true ||
    vendorChunk.isEntry === true ||
    runtimeChunk.isEntry === true
  ) {
    return [
      `Expected exactly one app entry, one vendor chunk, one Rolldown runtime chunk, and one shared database worker asset, but generated: ${outputDescription(javaScriptOutputs)}`,
    ];
  }

  const allowedStaticImports = new Set(
    applicationChunks.map((chunk) => {
      return chunk.fileName;
    }),
  );
  const violations = applicationChunks.flatMap((chunk) => {
    return chunkViolations(chunk, allowedStaticImports);
  });
  for (const chunk of [appChunk, runtimeChunk]) {
    const misplacedNodeModules = (chunk.moduleIds ?? []).filter(isNodeModule);
    if (misplacedNodeModules.length > 0) {
      violations.push(
        `${chunk.fileName}: third-party modules must be emitted only in the vendor chunk: ${misplacedNodeModules.join(", ")}`,
      );
    }
  }
  if (!(vendorChunk.moduleIds ?? []).some(isNodeModule)) {
    violations.push(
      `${vendorChunk.fileName}: vendor chunk has no node_modules`,
    );
  }

  const rawBytes = javaScriptOutputs.reduce((total, output) => {
    if (output.type === "chunk") {
      return total + new TextEncoder().encode(output.code).byteLength;
    }
    return (
      total +
      (typeof output.source === "string"
        ? new TextEncoder().encode(output.source).byteLength
        : output.source.byteLength)
    );
  }, 0);
  if (rawBytes > RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES) {
    violations.push(
      `JavaScript output: ${rawBytes} raw bytes exceeds ${RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES}`,
    );
  }
  return violations;
}

export function singleWorkerBundleViolations(
  chunks: readonly GeneratedChunk[],
): string[] {
  const chunk = chunks[0];
  if (chunks.length !== 1 || !chunk) {
    return [
      `Expected exactly one worker JavaScript bundle, but generated ${chunks.length}: ${chunks
        .map((chunk) => {
          return chunk.fileName;
        })
        .join(", ")}`,
    ];
  }
  return chunkViolations(chunk, new Set());
}

export function applicationJavaScriptBundlePlugin(): Plugin {
  return {
    apply: "build",
    enforce: "post",
    name: "platform-application-javascript-bundles",
    generateBundle(_options, bundle) {
      const violations = applicationBundleViolations(Object.values(bundle));
      if (violations.length > 0) {
        this.error(violations.join("\n"));
      }
    },
  };
}

export function singleWorkerJavaScriptBundlePlugin(): Plugin {
  return {
    apply: "build",
    enforce: "post",
    name: "platform-single-worker-javascript-bundle",
    generateBundle(_options, bundle) {
      const violations = singleWorkerBundleViolations(
        generatedChunks(Object.values(bundle)),
      );
      if (violations.length > 0) {
        this.error(violations.join("\n"));
      }
    },
  };
}
