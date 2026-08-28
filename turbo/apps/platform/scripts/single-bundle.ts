import type { Plugin } from "vite";

export const RAW_JAVASCRIPT_BUNDLE_LIMIT_BYTES = 8_500_000;

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
] as const;

interface GeneratedChunk {
  readonly code: string;
  readonly dynamicImports?: readonly string[];
  readonly fileName: string;
  readonly imports?: readonly string[];
  readonly moduleIds?: readonly string[];
  readonly type: "chunk";
}

function bundledPackage(moduleId: string): string | undefined {
  const normalized = moduleId.replaceAll("\\", "/");
  return FORBIDDEN_BUNDLED_PACKAGES.find((packageName) => {
    return normalized.includes(`/node_modules/${packageName}/`);
  });
}

export function singleBundleViolations(
  chunks: readonly GeneratedChunk[],
): string[] {
  if (chunks.length !== 1) {
    return [
      `Expected exactly one JavaScript bundle, but generated ${chunks.length}: ${chunks
        .map((chunk) => {
          return chunk.fileName;
        })
        .join(", ")}`,
    ];
  }

  const chunk = chunks[0];
  if (!chunk) {
    return ["Expected exactly one JavaScript bundle"];
  }
  const linkedJavaScript = [
    ...(chunk.imports ?? []),
    ...(chunk.dynamicImports ?? []),
  ];
  if (linkedJavaScript.length > 0) {
    return [
      `${chunk.fileName}: expected no JavaScript imports, found ${linkedJavaScript.join(", ")}`,
    ];
  }

  const forbiddenPackages = new Set(
    (chunk.moduleIds ?? [])
      .map(bundledPackage)
      .filter((packageName): packageName is string => {
        return packageName !== undefined;
      }),
  );
  if (forbiddenPackages.size > 0) {
    return [
      `${chunk.fileName}: forbidden packages reached the bundle: ${[...forbiddenPackages].join(", ")}`,
    ];
  }

  const rawBytes = new TextEncoder().encode(chunk.code).byteLength;
  return rawBytes > RAW_JAVASCRIPT_BUNDLE_LIMIT_BYTES
    ? [
        `${chunk.fileName}: ${rawBytes} raw bytes exceeds ${RAW_JAVASCRIPT_BUNDLE_LIMIT_BYTES}`,
      ]
    : [];
}

export function singleJavaScriptBundlePlugin(): Plugin {
  return {
    apply: "build",
    enforce: "post",
    name: "platform-single-javascript-bundle",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((item) => {
        return item.type === "chunk";
      });
      const violations = singleBundleViolations(chunks);
      if (violations.length > 0) {
        this.error(violations.join("\n"));
      }
    },
  };
}
