import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getAgentRoute } from "../agents/[id]/route";
import { POST as createRunRoute } from "../runs/route";
import { POST as claimJobRoute } from "../../runners/jobs/[id]/claim/route";
import { generateZeroToken } from "../../../../src/lib/auth/sandbox-token";
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
describe("Zero Agent E2E: create → run → zero token access", () => {
  let orgId: string;
  let userId: string;
  let agent: { agentId: string };

  beforeEach(async () => {
    context.setupMocks();
    const result = await onboardNewOrgAndUser(context);
    orgId = result.user.orgId;
    userId = result.user.userId;
    agent = result.agent;
  });

  it("should allow zero token from claimed run to read agent details", async () => {
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

    // ── 6. Use ZERO_TOKEN to read agent details ──
    // In production, zero agents use ZERO_TOKEN (injected via secrets) for
    // zero-layer route auth, not the sandbox token (VM0_TOKEN).
    const zeroToken = await generateZeroToken(userId, run.runId, orgId);

    // 6a. Should succeed
    const getRes = await getAgentRoute(
      new NextRequest(
        `http://localhost:3000/api/zero/agents/${agent.agentId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${zeroToken}`,
          },
        },
      ),
    );
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as {
      agentId: string;
      displayName: string;
      description: string;
    };
    expect(fetched.agentId).toBe(agent.agentId);
    expect(fetched.displayName).toBe("Test Agent");
    expect(fetched.description).toBe("Created by onboardNewOrgAndUser");
  });
});
