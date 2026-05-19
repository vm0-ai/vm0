import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ROUTES } from "../signals/route";

type RouteSegment =
  | {
      readonly kind: "catchAll";
    }
  | {
      readonly kind: "dynamic";
    }
  | {
      readonly kind: "literal";
      readonly value: string;
    };

const WEB_ROOT = fileURLToPath(new URL("../../../web/", import.meta.url));
const WEB_API_ROOT = path.join(WEB_ROOT, "app/api");
const WEB_API_REWRITES_PATH = path.join(WEB_ROOT, "api-backend-rewrites.js");
const ROUTE_FILE_SUFFIX = `${path.sep}route.ts`;

function pathnameSegments(pathname: string): readonly string[] {
  const normalized = pathname.replace(/^\/+/u, "").replace(/\/+$/u, "");
  return normalized.length === 0 ? [] : normalized.split("/");
}

function routeSegment(segment: string): RouteSegment {
  if (
    (segment.startsWith(":") && segment.endsWith("*")) ||
    /^\[\[?\.\.\..+\]\]?$/u.test(segment)
  ) {
    return { kind: "catchAll" };
  }

  if (segment.startsWith(":") || /^\[.+\]$/u.test(segment)) {
    return { kind: "dynamic" };
  }

  return { kind: "literal", value: segment };
}

function routePattern(pathname: string): readonly RouteSegment[] {
  return pathnameSegments(pathname).map(routeSegment);
}

function routePatternFromWebRouteFile(
  routeFile: string,
): readonly RouteSegment[] {
  const relativePath = path.relative(WEB_API_ROOT, routeFile);
  const routePath = relativePath.slice(0, -ROUTE_FILE_SUFFIX.length);
  return ["api", ...pathnameSegments(routePath)].map(routeSegment);
}

function routeFilesUnder(directory: string): readonly string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const routeFiles: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      routeFiles.push(...routeFilesUnder(entryPath));
    } else if (entry.isFile() && entry.name === "route.ts") {
      routeFiles.push(entryPath);
    }
  }
  return routeFiles;
}

function jsStringValue(
  expression: string,
  constants: ReadonlyMap<string, string>,
): string | undefined {
  if (expression.startsWith('"') && expression.endsWith('"')) {
    const parsed: unknown = JSON.parse(expression);
    return typeof parsed === "string" ? parsed : undefined;
  }

  if (expression.startsWith("`") && expression.endsWith("`")) {
    let isResolved = true;
    const value = expression
      .slice(1, -1)
      .replace(/\$\{([A-Z0-9_]+)\}/gu, (_match, name: string) => {
        const value = constants.get(name);
        if (value === undefined) {
          isResolved = false;
          return "";
        }
        return value;
      });
    return isResolved ? value : undefined;
  }

  return constants.get(expression);
}

function apiBackendRewriteConstants(
  source: string,
): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  const constantPattern = /const\s+([A-Z0-9_]+)\s*=\s*("[^"]+"|`[^`]+`);/gu;
  let foundNewConstant = true;

  while (foundNewConstant) {
    foundNewConstant = false;
    let match = constantPattern.exec(source);
    while (match) {
      const [, name, expression] = match;
      if (name && expression && !constants.has(name)) {
        const value = jsStringValue(expression, constants);
        if (value !== undefined) {
          constants.set(name, value);
          foundNewConstant = true;
        }
      }
      match = constantPattern.exec(source);
    }
  }

  return constants;
}

function apiBackendRewritePaths(): readonly string[] {
  const source = readFileSync(WEB_API_REWRITES_PATH, "utf8");
  const constants = apiBackendRewriteConstants(source);
  const paths: string[] = [];
  const rewriteEntryPattern =
    /\[\s*("[^"]+"|`[^`]+`|[A-Z0-9_]+)\s*,\s*("[^"]+")/gu;
  let match = rewriteEntryPattern.exec(source);

  while (match) {
    const sourcePath = match[1]
      ? jsStringValue(match[1], constants)
      : undefined;
    if (sourcePath) {
      paths.push(sourcePath);
    }
    const destinationPath = match[2]
      ? jsStringValue(match[2], constants)
      : undefined;
    if (destinationPath) {
      paths.push(destinationPath);
    }
    match = rewriteEntryPattern.exec(source);
  }

  return paths;
}

function segmentMatches(
  webSegment: RouteSegment,
  apiSegment: RouteSegment,
): boolean {
  if (webSegment.kind === "catchAll") {
    return true;
  }

  if (webSegment.kind === "dynamic") {
    return apiSegment.kind !== "catchAll";
  }

  return apiSegment.kind === "literal" && webSegment.value === apiSegment.value;
}

function patternCovers(
  webPattern: readonly RouteSegment[],
  apiPattern: readonly RouteSegment[],
): boolean {
  const catchAllIndex = webPattern.findIndex((segment) => {
    return segment.kind === "catchAll";
  });

  if (catchAllIndex !== -1) {
    return (
      catchAllIndex === webPattern.length - 1 &&
      apiPattern.length >= catchAllIndex &&
      webPattern.slice(0, catchAllIndex).every((segment, index) => {
        const apiSegment = apiPattern[index];
        return apiSegment ? segmentMatches(segment, apiSegment) : false;
      })
    );
  }

  return (
    webPattern.length === apiPattern.length &&
    webPattern.every((segment, index) => {
      const apiSegment = apiPattern[index];
      return apiSegment ? segmentMatches(segment, apiSegment) : false;
    })
  );
}

describe("web API compatibility", () => {
  it("routes every API endpoint through an existing web route or API backend rewrite", () => {
    const webRoutePatterns = routeFilesUnder(WEB_API_ROOT).map(
      routePatternFromWebRouteFile,
    );
    const apiBackendRewritePatterns =
      apiBackendRewritePaths().map(routePattern);
    const webCompatiblePatterns = [
      ...webRoutePatterns,
      ...apiBackendRewritePatterns,
    ];

    const apiPathnames = [
      ...new Set(
        ROUTES.map(({ route }) => {
          return route.path;
        }).filter((pathname) => {
          return pathname.startsWith("/api/");
        }),
      ),
    ].sort();

    const missingWebCompatibility = apiPathnames.filter((apiPathname) => {
      const apiPattern = routePattern(apiPathname);
      return !webCompatiblePatterns.some((webPattern) => {
        return patternCovers(webPattern, apiPattern);
      });
    });

    expect(
      missingWebCompatibility,
      `API routes missing an apps/web/app/api route or api-backend rewrite:\n${missingWebCompatibility.join("\n")}`,
    ).toStrictEqual([]);
  });
});
