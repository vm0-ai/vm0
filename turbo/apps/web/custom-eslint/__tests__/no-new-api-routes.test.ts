import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { WEB_API_ROUTE_BASELINE } from "../baselines/web-api-routes.ts";
import {
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
      filename: path.join(webRoot, "app/api/auth/me/route.ts"),
    },
    {
      code: "export async function GET() {}",
      filename: path.join(
        webRoot,
        "app/api/zero/remote-agent/[...path]/route.ts",
      ),
    },
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

  it("returns stale baseline entries when allowlisted routes are deleted", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "web-api-routes-"));
    const existingRoute = WEB_API_ROUTE_BASELINE[0];
    const routePath = path.join(tempDir, existingRoute);
    mkdirSync(path.dirname(routePath), { recursive: true });
    writeFileSync(routePath, "");

    const missing = missingBaselineRoutes(tempDir);

    expect(missing).not.toContain(existingRoute);
    expect(missing).toContain(WEB_API_ROUTE_BASELINE[1]);
  });
});
