interface ChunkModuleInfo {
  readonly importedIds: readonly string[];
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
  let startupModules: ReadonlySet<string> | undefined;

  function getStartupModules(context: ChunkingContext): ReadonlySet<string> {
    if (startupModules) {
      return startupModules;
    }

    const visited = new Set<string>();
    const pending = [normalizedEntryModuleId];
    while (pending.length > 0) {
      const moduleId = pending.pop();
      if (moduleId === undefined) {
        continue;
      }
      const normalizedModuleId = normalizeModuleId(moduleId);
      if (visited.has(normalizedModuleId)) {
        continue;
      }
      visited.add(normalizedModuleId);

      const moduleInfo = context.getModuleInfo(moduleId);
      if (moduleInfo === null) {
        continue;
      }
      for (const importedId of moduleInfo.importedIds) {
        if (!visited.has(normalizeModuleId(importedId))) {
          pending.push(importedId);
        }
      }
    }

    startupModules = visited;
    return startupModules;
  }

  return (moduleId: string, context: ChunkingContext): string | null => {
    const chunkName = packageChunkName(moduleId);
    if (
      chunkName === null ||
      !getStartupModules(context).has(normalizeModuleId(moduleId))
    ) {
      return null;
    }
    return chunkName;
  };
}
