import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getAgentRoute } from "../agents/[id]/route";
import { POST as createRunRoute } from "../runs/route";
import { POST as claimJobRoute } from "../../runners/jobs/[id]/claim/route";
import {
  seedSeedSkills,
  seedSeedSkillStorages,
  clearSkillsData,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { onboardNewOrgAndUser } from "./zero-api-test-helper";

const context = testContext();

/**
 * End-to-end zero agent flow:
 *   onboarding (model provider) → create agent → run agent → claim job → use sandbox token
 *
 * Every step goes through real API route handlers.
 * The only test helpers used are infrastructure (auth mock, skill seeding).
 */
describe("Zero Agent E2E: create → run → sandbox token access", () => {
  let orgSlug: string;
  let agent: { agentId: string };

  beforeAll(async () => {
    await clearSkillsData();
    await seedSeedSkills();
    await seedSeedSkillStorages();
  });

  beforeEach(async () => {
    context.setupMocks();
    const result = await onboardNewOrgAndUser(context);
    orgSlug = result.orgSlug;
    agent = result.agent;
  });

  it("should allow sandbox token from claimed run to read agent details", async () => {
    // ── 4. Run agent via API ──
    const runRes = await createRunRoute(
      new NextRequest("http://localhost:3000/api/zero/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: agent.agentId,
          prompt: "Hello agent",
        }),
      }),
    );
    expect(runRes.status).toBe(201);
    const run = (await runRes.json()) as { runId: string };
    expect(run.runId).toBeTruthy();

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
      experimentalCapabilities: string[];
    };

    // Verify the execution context contains a sandbox token and capabilities
    expect(executionContext.sandboxToken).toBeTruthy();
    expect(executionContext.sandboxToken).toMatch(/^vm0_sandbox_/);
    expect(executionContext.experimentalCapabilities).toEqual(
      expect.arrayContaining(["agent:read"]),
    );

    // ── 6. Use sandbox token to read agent details ──
    // This is what happens inside the sandbox: the runner injects
    // sandboxToken as VM0_TOKEN and VM0_ACTIVE_ORG, and the agent CLI
    // uses them to call the API with ?org=<slug>.
    // Sandbox tokens are processed before the Clerk session fallback in
    // getAuthContext, so the Clerk session state does not affect sandbox auth.

    // 6a. Without ?org= → sandbox token has no orgId, request fails
    // (in production, runner also injects VM0_ACTIVE_ORG for this reason)
    const noOrgRes = await getAgentRoute(
      new NextRequest(
        `http://localhost:3000/api/zero/agents/${agent.agentId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${executionContext.sandboxToken}`,
          },
        },
      ),
    );
    expect(noOrgRes.ok).toBe(false);

    // 6b. With ?org= (simulating VM0_ACTIVE_ORG) → should succeed
    const getRes = await getAgentRoute(
      new NextRequest(
        `http://localhost:3000/api/zero/agents/${agent.agentId}?org=${orgSlug}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${executionContext.sandboxToken}`,
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
