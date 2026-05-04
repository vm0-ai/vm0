import { existsSync } from "node:fs";
import * as path from "node:path";

import {
  WEB_API_ROUTE_BASELINE,
  WEB_API_ROUTE_BASELINE_SET,
} from "../baselines/web-api-routes.ts";
import { createRule } from "../utils.ts";

const APP_API_ROUTE_PREFIX = "app/api/";
const APP_API_ROUTE_MARKER = "/app/api/";
const ROUTE_SUFFIX = "/route.ts";

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
      staleApiRouteBaseline:
        "Web API route baseline contains {{count}} deleted route(s). Remove stale baseline entries: {{routes}}",
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
