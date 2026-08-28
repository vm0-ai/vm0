import type { Plugin } from "vite";

export const RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES = 8_500_000;

const SHARED_DATABASE_WORKER_FILE_PREFIX = "assets/shared-database-worker-";

const FORBIDDEN_BUNDLED_PACKAGES = [
  "@base-org",
  "@clerk/clerk-js",
  "@clerk/ui",
  "@coinbase",
  "@solana",
  "@wallet-standard",
  "highlight.js",
  "katex",
  "lowlight",
  "prismjs",
  "rehype-katex",
  "rehype-prism-plus",
  "remark-math",
  "tr46",
] as const;

interface GeneratedChunk {
  readonly code: string;
  readonly dynamicImports?: readonly string[];
  readonly fileName: string;
  readonly imports?: readonly string[];
  readonly moduleIds?: readonly string[];
  readonly type: "chunk";
}

interface GeneratedAsset {
  readonly fileName: string;
  readonly source: string | Uint8Array;
  readonly type: "asset";
}

type GeneratedOutput = GeneratedAsset | GeneratedChunk;

function bundledPackage(moduleId: string): string | undefined {
  const normalized = moduleId.replaceAll("\\", "/");
  return FORBIDDEN_BUNDLED_PACKAGES.find((packageName) => {
    return normalized.includes(`/node_modules/${packageName}/`);
  });
}

export function applicationBundleViolations(
  outputs: readonly GeneratedOutput[],
): string[] {
  const javaScriptOutputs = outputs.filter((output) => {
    return output.fileName.endsWith(".js");
  });
  const applicationChunks = javaScriptOutputs.filter(
    (output): output is GeneratedChunk => {
      return output.type === "chunk";
    },
  );
  const workerAssets = javaScriptOutputs.filter(
    (output): output is GeneratedAsset => {
      return (
        output.type === "asset" &&
        output.fileName.startsWith(SHARED_DATABASE_WORKER_FILE_PREFIX)
      );
    },
  );
  const applicationChunk = applicationChunks[0];
  const workerAsset = workerAssets[0];
  if (
    javaScriptOutputs.length !== 2 ||
    applicationChunks.length !== 1 ||
    workerAssets.length !== 1 ||
    !applicationChunk ||
    !workerAsset
  ) {
    return [
      `Expected exactly one application JavaScript chunk and one shared database worker JavaScript asset, but generated: ${
        javaScriptOutputs.length === 0
          ? "none"
          : javaScriptOutputs
              .map((output) => {
                return `${output.fileName} (${output.type})`;
              })
              .join(", ")
      }`,
    ];
  }

  const violations = chunkViolations(applicationChunk);
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

function chunkViolations(chunk: GeneratedChunk): string[] {
  const violations: string[] = [];
  const linkedJavaScript = [
    ...(chunk.imports ?? []),
    ...(chunk.dynamicImports ?? []),
  ];
  if (linkedJavaScript.length > 0) {
    violations.push(
      `${chunk.fileName}: expected no JavaScript imports, found ${linkedJavaScript.join(", ")}`,
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
  return chunkViolations(chunk);
}

function generatedChunks(
  outputs: readonly GeneratedOutput[],
): GeneratedChunk[] {
  return outputs.filter((output): output is GeneratedChunk => {
    return output.type === "chunk";
  });
}

export function applicationJavaScriptBundlePlugin(): Plugin {
  return {
    apply: "build",
    enforce: "post",
    name: "platform-application-javascript-bundle",
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
