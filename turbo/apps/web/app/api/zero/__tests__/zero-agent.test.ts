import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as createRunRoute } from "../runs/route";
import { POST as claimJobRoute } from "../../runners/jobs/[id]/claim/route";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { onboardNewOrgAndUser } from "./zero-api-test-helper";

const context = testContext();

/**
 * End-to-end zero agent flow:
 *   onboarding (model provider) → create agent → run agent → claim job → use zero token
 *
 * Every step goes through real API route handlers.
 * The only test helpers used are infrastructure (auth mock, skill seeding).
 */
describe("Zero Agent E2E: create → run → claim job", () => {
  let agent: { agentId: string };

  beforeEach(async () => {
    context.setupMocks();
    const result = await onboardNewOrgAndUser(context);
    agent = result.agent;
  });

  it("should claim a run for an onboarded zero agent", async () => {
    // ── 4. Run agent via API ──
    const runRes = await createRunRoute(
      new NextRequest("http://localhost:3000/api/zero/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agent.agentId,
          prompt: "Hello agent",
        }),
      }),
    );
    expect(runRes.status).toBe(201);
    const run = (await runRes.json()) as { runId: string };
    expect(run.runId).toBeTruthy();

    // Flush deferred after() callbacks (dispatch is deferred)
    await context.mocks.flushAfter();

    // ── 5. Claim job as official runner via API ──
    // The run was dispatched to runner_job_queue (RUNNER_DEFAULT_GROUP=vm0/default).
    // Official runner token = vm0_official_<OFFICIAL_RUNNER_SECRET>
    const officialRunnerToken = `vm0_official_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`;
    const claimRes = await claimJobRoute(
      new NextRequest(
        `http://localhost:3000/api/runners/jobs/${run.runId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${officialRunnerToken}`,
          },
          body: JSON.stringify({}),
        },
      ),
    );
    expect(claimRes.status).toBe(200);
    const executionContext = (await claimRes.json()) as {
      sandboxToken: string;
    };

    // Verify the execution context contains a sandbox token (now without capabilities)
    expect(executionContext.sandboxToken).toBeTruthy();
    expect(executionContext.sandboxToken).toMatch(/^vm0_sandbox_/);
  });
});
