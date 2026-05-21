import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  expandedBaselineRoutes,
  expandedBaselineRoutesSinceReference,
  extractWebApiRouteBaselineRoutes,
  missingBaselineRoutes,
  noNewApiRoutes,
  webApiRoutePath,
} from "../rules/no-new-api-routes.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const webRoot = fileURLToPath(new URL("../..", import.meta.url));

ruleTester.run("no-new-api-routes", noNewApiRoutes, {
  valid: [
    {
      code: "export async function GET() {}",
      filename: path.join(webRoot, "src/not-api-route.ts"),
    },
  ],
  invalid: [
    {
      code: "export async function GET() {}",
      filename: path.join(webRoot, "app/api/new-backend-only-route/route.ts"),
      errors: [{ messageId: "noNewApiRoute" }],
    },
  ],
});

describe("webApiRoutePath", () => {
  it("normalizes absolute web route filenames to app-relative paths", () => {
    expect(
      webApiRoutePath(
        path.join(webRoot, "app/api/zero/billing/status/route.ts"),
      ),
    ).toBe("app/api/zero/billing/status/route.ts");
  });

  it("returns null for non-route files", () => {
    expect(
      webApiRoutePath(
        path.join(webRoot, "app/api/zero/billing/status/test.ts"),
      ),
    ).toBeNull();
  });
});

describe("missingBaselineRoutes", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("returns no stale baseline entries after the web route baseline is empty", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "web-api-routes-"));

    const missing = missingBaselineRoutes(tempDir);

    expect(missing).toEqual([]);
  });
});

describe("web API route baseline expansion", () => {
  let tempGitDir: string | null = null;

  afterEach(() => {
    delete process.env.WEB_API_ROUTE_BASELINE_REFERENCE;
    if (tempGitDir) {
      rmSync(tempGitDir, { recursive: true, force: true });
      tempGitDir = null;
    }
  });

  it("extracts route entries from a baseline source file", () => {
    expect(
      extractWebApiRouteBaselineRoutes(`
        export const WEB_API_ROUTE_BASELINE = [
          "app/api/auth/me/route.ts",
          "app/api/zero/chat/messages/route.ts",
        ] as const;
      `),
    ).toEqual([
      "app/api/auth/me/route.ts",
      "app/api/zero/chat/messages/route.ts",
    ]);
  });

  it("allows baseline routes to shrink without reporting additions", () => {
    expect(
      expandedBaselineRoutes(
        ["app/api/auth/me/route.ts", "app/api/zero/chat/messages/route.ts"],
        ["app/api/auth/me/route.ts"],
      ),
    ).toEqual([]);
  });

  it("reports routes added to the baseline", () => {
    expect(
      expandedBaselineRoutes(
        ["app/api/auth/me/route.ts"],
        ["app/api/auth/me/route.ts", "app/api/new-backend-only-route/route.ts"],
      ),
    ).toEqual(["app/api/new-backend-only-route/route.ts"]);
  });

  it("does not report additions since the configured git reference when the current baseline is empty", () => {
    tempGitDir = mkdtempSync(path.join(os.tmpdir(), "web-api-routes-git-"));
    const baselinePath = path.join(
      tempGitDir,
      "custom-eslint/baselines/web-api-routes.ts",
    );
    mkdirSync(path.dirname(baselinePath), { recursive: true });
    writeFileSync(
      baselinePath,
      `
        export const WEB_API_ROUTE_BASELINE = [] as const;
      `,
    );
    execFileSync("git", ["init"], { cwd: tempGitDir });
    execFileSync("git", ["add", "."], { cwd: tempGitDir });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test User",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "seed baseline",
      ],
      { cwd: tempGitDir },
    );
    process.env.WEB_API_ROUTE_BASELINE_REFERENCE = "HEAD";

    const expanded = expandedBaselineRoutesSinceReference(tempGitDir);

    expect(expanded).toEqual([]);
  });
});
