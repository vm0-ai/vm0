import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

import {
  computeWebApiRouteBaselineHash,
  WEB_API_ROUTE_BASELINE,
  WEB_API_ROUTE_BASELINE_HASH,
  WEB_API_ROUTE_BASELINE_SET,
} from "../baselines/web-api-routes.ts";
import { createRule } from "../utils.ts";

const APP_API_ROUTE_PREFIX = "app/api/";
const APP_API_ROUTE_MARKER = "/app/api/";
const ROUTE_SUFFIX = "/route.ts";

const BASELINE_FILE_FROM_WEB_ROOT = "custom-eslint/baselines/web-api-routes.ts";

const reportedBaselineExpansionRoots = new Set<string>();
const reportedBaselineHashRoots = new Set<string>();
const reportedStaleBaselineRoots = new Set<string>();

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function webApiRoutePath(filename: string): string | null {
  const normalized = normalizePath(filename);
  const markerIndex = normalized.indexOf(APP_API_ROUTE_MARKER);
  const routePath =
    markerIndex === -1 ? normalized : normalized.slice(markerIndex + 1);

  if (
    routePath.startsWith(APP_API_ROUTE_PREFIX) &&
    routePath.endsWith(ROUTE_SUFFIX)
  ) {
    return routePath;
  }

  return null;
}

function webRootFromFilename(filename: string): string {
  const normalized = normalizePath(filename);
  const markerIndex = normalized.indexOf(APP_API_ROUTE_MARKER);
  if (markerIndex === -1) {
    return process.cwd();
  }
  return normalized.slice(0, markerIndex);
}

export function missingBaselineRoutes(webRoot: string): readonly string[] {
  return WEB_API_ROUTE_BASELINE.filter((routePath) => {
    return !existsSync(path.join(webRoot, routePath));
  });
}

export function expandedBaselineRoutes(
  referenceRoutes: readonly string[],
  routes: readonly string[] = WEB_API_ROUTE_BASELINE,
): readonly string[] {
  const referenceRouteSet = new Set<string>(referenceRoutes);
  return routes.filter((routePath) => {
    return !referenceRouteSet.has(routePath);
  });
}

export function extractWebApiRouteBaselineRoutes(
  source: string,
): readonly string[] {
  const routes: string[] = [];
  const routePattern = /"((?:app\/api\/)[^"]+\/route\.ts)"/gu;
  let match = routePattern.exec(source);
  while (match) {
    const routePath = match[1];
    if (routePath) {
      routes.push(routePath);
    }
    match = routePattern.exec(source);
  }
  return routes;
}

function gitOutput(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitRootForWebRoot(webRoot: string): string | null {
  return gitOutput(webRoot, ["rev-parse", "--show-toplevel"]);
}

function baselineReferenceForGitRoot(gitRoot: string): string | null {
  const explicitReference =
    process.env.WEB_API_ROUTE_BASELINE_REFERENCE?.trim();
  if (explicitReference) {
    return explicitReference;
  }

  const baseRef = process.env.GITHUB_BASE_REF?.trim();
  const upstreamRef = baseRef ? `origin/${baseRef}` : "origin/main";
  return gitOutput(gitRoot, ["merge-base", "HEAD", upstreamRef]);
}

export function expandedBaselineRoutesSinceReference(
  webRoot: string,
): readonly string[] {
  const gitRoot = gitRootForWebRoot(webRoot);
  if (!gitRoot) {
    return [];
  }

  const reference = baselineReferenceForGitRoot(gitRoot);
  if (!reference) {
    return [];
  }

  const baselinePath = normalizePath(
    path.relative(gitRoot, path.join(webRoot, BASELINE_FILE_FROM_WEB_ROOT)),
  );
  const referenceSource = gitOutput(gitRoot, [
    "show",
    `${reference}:${baselinePath}`,
  ]);
  if (!referenceSource) {
    return [];
  }

  return expandedBaselineRoutes(
    extractWebApiRouteBaselineRoutes(referenceSource),
  );
}

function staleBaselineMessageData(missingRoutes: readonly string[]): {
  readonly count: string;
  readonly routes: string;
} {
  const visibleRoutes = missingRoutes.slice(0, 5);
  const hiddenCount = missingRoutes.length - visibleRoutes.length;
  return {
    count: String(missingRoutes.length),
    routes:
      hiddenCount > 0
        ? `${visibleRoutes.join(", ")}, and ${hiddenCount} more`
        : visibleRoutes.join(", "),
  };
}

export function webApiRouteBaselineHashIsCurrent(): boolean {
  return computeWebApiRouteBaselineHash() === WEB_API_ROUTE_BASELINE_HASH;
}

export const noNewApiRoutes = createRule({
  name: "no-new-api-routes",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow adding new Next.js API routes under apps/web/app/api.",
      recommended: true,
    },
    schema: [],
    messages: {
      noNewApiRoute:
        "Do not add new API routes under apps/web/app/api. Add this route to apps/api and keep web as legacy/fallback only.",
      expandedApiRouteBaseline:
        "Web API route baseline cannot grow. Remove added baseline entries, add the route to apps/api, and use a Next.js rewrite when web compatibility is needed: {{routes}}",
      staleApiRouteBaseline:
        "Web API route baseline contains {{count}} deleted route(s). Remove stale baseline entries: {{routes}}",
      changedApiRouteBaseline:
        "Web API route baseline changed without updating WEB_API_ROUTE_BASELINE_HASH. Remove accidental baseline edits instead of allowlisting new web API routes.",
    },
  },
  create(context) {
    return {
      Program(node) {
        const routePath = webApiRoutePath(context.filename);
        if (!routePath) {
          return;
        }

        if (!WEB_API_ROUTE_BASELINE_SET.has(routePath)) {
          context.report({
            node,
            messageId: "noNewApiRoute",
          });
        }

        const webRoot = webRootFromFilename(context.filename);
        if (!reportedBaselineExpansionRoots.has(webRoot)) {
          reportedBaselineExpansionRoots.add(webRoot);
          const expandedRoutes = expandedBaselineRoutesSinceReference(webRoot);
          if (expandedRoutes.length > 0) {
            context.report({
              node,
              messageId: "expandedApiRouteBaseline",
              data: staleBaselineMessageData(expandedRoutes),
            });
          }
        }

        if (!reportedBaselineHashRoots.has(webRoot)) {
          reportedBaselineHashRoots.add(webRoot);
          if (!webApiRouteBaselineHashIsCurrent()) {
            context.report({
              node,
              messageId: "changedApiRouteBaseline",
            });
          }
        }

        if (reportedStaleBaselineRoots.has(webRoot)) {
          return;
        }
        reportedStaleBaselineRoots.add(webRoot);

        const missingRoutes = missingBaselineRoutes(webRoot);
        if (missingRoutes.length > 0) {
          context.report({
            node,
            messageId: "staleApiRouteBaseline",
            data: staleBaselineMessageData(missingRoutes),
          });
        }
      },
    };
  },
});
