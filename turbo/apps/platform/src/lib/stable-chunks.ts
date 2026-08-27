interface ChunkModuleInfo {
  readonly importers: readonly string[];
}

interface ChunkingContext {
  readonly getModuleInfo: (moduleId: string) => ChunkModuleInfo | null;
}

const PNPM_PACKAGE_PREFIX =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?/u;

const chunkGroups = [
  {
    name: "vendor-foundation",
    packages: [
      "@floating-ui",
      "@radix-ui",
      "ccstate",
      "ccstate-react",
      "i18next",
      "idb",
      "lucide-react",
      "path-to-regexp",
      "react",
      "react-dom",
      "react-i18next",
      "scheduler",
      "zod",
    ],
  },
  {
    name: "vendor-auth",
    packages: ["@clerk"],
  },
  {
    name: "vendor-content",
    packages: [
      "@tiptap",
      "@uiw/react-markdown-preview",
      "hast-util-to-jsx-runtime",
      "highlight.js",
      "katex",
      "lowlight",
      "mermaid",
      "micromark-util-sanitize-uri",
      "rehype-attr",
      "rehype-autolink-headings",
      "rehype-ignore",
      "rehype-katex",
      "rehype-prism-plus",
      "rehype-raw",
      "rehype-rewrite",
      "rehype-slug",
      "remark-cjk-friendly",
      "remark-cjk-friendly-gfm-strikethrough",
      "remark-gfm",
      "remark-github-blockquote-alert",
      "remark-math",
      "remark-parse",
      "remark-rehype",
      "unified",
      "unist-util-visit",
    ],
  },
  {
    name: "vendor-services",
    packages: ["@sentry", "ably", "posthog-js"],
  },
] as const;

function normalizeModuleId(moduleId: string): string {
  return moduleId.replaceAll("\\", "/");
}

function packagePath(moduleId: string): string | null {
  const normalizedId = normalizeModuleId(moduleId);
  const match = PNPM_PACKAGE_PREFIX.exec(normalizedId);
  return match ? normalizedId.slice(match.index + match[0].length) : null;
}

function matchesPackage(path: string, packageName: string): boolean {
  return path === packageName || path.startsWith(`${packageName}/`);
}

function packageChunkName(moduleId: string): string | null {
  const path = packagePath(moduleId);
  if (path === null) {
    return null;
  }

  for (const group of chunkGroups) {
    if (
      group.packages.some((packageName) => {
        return matchesPackage(path, packageName);
      })
    ) {
      return group.name;
    }
  }
  return null;
}

export function createStableChunkName(entryModuleId: string) {
  const normalizedEntryModuleId = normalizeModuleId(entryModuleId);
  const startupModules = new Set<string>();

  // Walking static importers back to main keeps feature-only dependencies in
  // Rolldown's normal lazy chunks instead of pulling them into startup.
  function isStartupModule(
    moduleId: string,
    context: ChunkingContext,
    visiting = new Set<string>(),
  ): boolean {
    if (startupModules.has(moduleId)) {
      return true;
    }
    if (normalizeModuleId(moduleId) === normalizedEntryModuleId) {
      startupModules.add(moduleId);
      return true;
    }
    if (visiting.has(moduleId)) {
      return false;
    }

    const moduleInfo = context.getModuleInfo(moduleId);
    if (moduleInfo === null) {
      return false;
    }

    visiting.add(moduleId);
    const startupModule = moduleInfo.importers.some((importerId) => {
      return isStartupModule(importerId, context, visiting);
    });
    visiting.delete(moduleId);
    // A false result can be specific to the current cycle traversal. Cache only
    // proven reachability so later Rolldown callbacks cannot inherit that
    // contextual miss and become order-dependent.
    if (startupModule) {
      startupModules.add(moduleId);
    }
    return startupModule;
  }

  return (moduleId: string, context: ChunkingContext): string | null => {
    const chunkName = packageChunkName(moduleId);
    if (chunkName === null || !isStartupModule(moduleId, context)) {
      return null;
    }
    return chunkName;
  };
}
