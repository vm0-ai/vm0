import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { zeroHostCommand } from "../index";

const DEPLOYMENTS_URL =
  "http://localhost:3000/api/zero/host/sites/:site/deployments";
const ALIAS_URL = "https://demo-site.sites.example.com";

describe("zero host versions command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  it("lists immutable deployment versions for a logical site slug", async () => {
    server.use(
      http.get(DEPLOYMENTS_URL, ({ params, request }) => {
        expect(params.site).toBe("demo-site");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          siteId: "00000000-0000-4000-8000-000000000001",
          site: "demo-site",
          publicSlug: "demo-site",
          aliasUrl: ALIAS_URL,
          activeDeploymentId: "00000000-0000-4000-8000-000000000003",
          activeDeploymentVersion: 2,
          deployments: [
            {
              deploymentId: "00000000-0000-4000-8000-000000000003",
              deploymentVersion: 2,
              artifactUrl:
                "https://dpl-00000000-0000-4000-8000-000000000003.sites.example.com",
              status: "ready",
              isActive: true,
              createdAt: "2026-07-22T02:00:00.000Z",
              readyAt: "2026-07-22T02:01:00.000Z",
            },
            {
              deploymentId: "00000000-0000-4000-8000-000000000002",
              deploymentVersion: 1,
              artifactUrl:
                "https://dpl-00000000-0000-4000-8000-000000000002.sites.example.com",
              status: "ready",
              isActive: false,
              createdAt: "2026-07-22T01:00:00.000Z",
              readyAt: "2026-07-22T01:01:00.000Z",
            },
          ],
        });
      }),
    );

    await zeroHostCommand.parseAsync([
      "node",
      "cli",
      "versions",
      "demo-site",
      "--json",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      site: "demo-site",
      aliasUrl: ALIAS_URL,
      activeDeploymentVersion: 2,
      deployments: [
        expect.objectContaining({ deploymentVersion: 2, isActive: true }),
        expect.objectContaining({ deploymentVersion: 1, isActive: false }),
      ],
    });
  });
});
