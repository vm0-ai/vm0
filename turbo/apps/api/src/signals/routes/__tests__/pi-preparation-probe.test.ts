import { testPiPreparationProbeContract } from "@okouai/api-contracts/contracts/test-pi-preparation-probe";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { testPiPreparationProbeRoutes } from "../test-pi-preparation-probe";

const context = testContext();

function client() {
  return setupApp({ context, routes: testPiPreparationProbeRoutes })(
    testPiPreparationProbeContract,
  );
}

describe("Pi preparation probe", () => {
  it("hydrates native resources and opens the official JSONL session", async () => {
    mockEnv("ENV", "development");
    const response = await accept(
      client().run({
        body: {
          iterations: 1,
          mode: "filesystem",
          profile: "minimal",
          rebuild_fixture: true,
        },
      }),
      [200],
    );

    expect(response.body.network_download_measured).toBeFalsy();
    expect(response.body.mode).toBe("filesystem");
    expect(response.body.samples).toHaveLength(1);
    expect(response.body.samples[0]?.official).toMatchObject({
      agents_file_count: 2,
      diagnostic_count: 0,
      discovered_skill_count: 4,
      session_header_cwd: "/home/user/workspace",
      session_persisted: true,
    });
  });

  it("loads prewarmed Pi resources and native JSONL from memory", async () => {
    mockEnv("ENV", "development");
    const response = await accept(
      client().run({
        body: {
          iterations: 1,
          mode: "memory",
          profile: "minimal",
          rebuild_fixture: true,
        },
      }),
      [200],
    );

    expect(response.body.mode).toBe("memory");
    expect(response.body.samples).toHaveLength(1);
    expect(response.body.samples[0]).toMatchObject({
      archive_extract_ms: 0,
      cleanup_ms: 0,
      lease_create_ms: 0,
      session_write_ms: 0,
      official: {
        agents_file_count: 2,
        diagnostic_count: 0,
        discovered_skill_count: 4,
        session_header_cwd: "/home/user/workspace",
        session_list_ms: 0,
        session_persisted: false,
      },
    });
  });
});
