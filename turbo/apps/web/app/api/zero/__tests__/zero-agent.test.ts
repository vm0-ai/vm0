import { describe, it, expect, beforeEach } from "vitest";
import { POST as createAgentRoute } from "../agents/route";
import { GET as getAgentRoute } from "../agents/[name]/route";
import { PUT as updateInstructionsRoute } from "../agents/[name]/instructions/route";
import { POST as upsertModelProviderRoute } from "../model-providers/route";
import { POST as createRunRoute } from "../runs/route";
import { POST as claimJobRoute } from "../../runners/jobs/[id]/claim/route";
import {
  createTestRequest,
  createTestCliToken,
  seedSeedSkills,
  seedSeedSkillStorages,
  clearSkillsData,
} from "../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

const context = testContext();

/**
 * End-to-end zero agent flow:
 *   onboarding (model provider) → create agent → run agent → claim job → use sandbox token
 *
 * Every step goes through real API route handlers.
 * The only test helpers used are infrastructure (auth mock, request construction, skill seeding).
 */
describe("Zero Agent E2E: create → run → sandbox token access", () => {
  let user: UserContext;
  let cliToken: string;
  let orgSlug: string;

  beforeEach(async () => {
    context.setupMocks();
    await clearSkillsData();
    await seedSeedSkills();
    await seedSeedSkillStorages();
    user = await context.setupUser();
    cliToken = await createTestCliToken(user.userId);
    orgSlug = `org-${user.userId.slice(-8)}`;
  });

  it("should allow sandbox token from claimed run to read agent details", async () => {
    // ── 1. Onboarding: set up model provider via API ──
    const providerRes = await upsertModelProviderRoute(
      createTestRequest(
        `http://localhost:3000/api/zero/model-providers?org=${orgSlug}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cliToken}`,
          },
          body: JSON.stringify({
            type: "anthropic-api-key",
            secret: "sk-ant-test-key",
          }),
        },
      ),
    );
    expect(providerRes.status).toBe(201);

    // ── 2. Create agent via API ──
    const agentRes = await createAgentRoute(
      createTestRequest(
        `http://localhost:3000/api/zero/agents?org=${orgSlug}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cliToken}`,
          },
          body: JSON.stringify({
            connectors: [],
            displayName: "E2E Agent",
            description: "Created for sandbox token test",
          }),
        },
      ),
    );
    expect(agentRes.status).toBe(201);
    const agent = await agentRes.json();
    expect(agent.name).toBeTruthy();
    expect(agent.agentComposeId).toBeTruthy();

    // ── 3. Upload instructions (creates agent-instructions storage) ──
    const instructionsRes = await updateInstructionsRoute(
      createTestRequest(
        `http://localhost:3000/api/zero/agents/${agent.name}/instructions?org=${orgSlug}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cliToken}`,
          },
          body: JSON.stringify({
            content: "# Agent Instructions\nBe helpful.",
          }),
        },
      ),
    );
    expect(instructionsRes.status).toBe(200);

    // ── 4. Run agent via API ──
    const runRes = await createRunRoute(
      createTestRequest("http://localhost:3000/api/zero/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cliToken}`,
        },
        body: JSON.stringify({
          agentComposeId: agent.agentComposeId,
          prompt: "Hello agent",
        }),
      }),
    );
    expect(runRes.status).toBe(201);
    const run = await runRes.json();
    expect(run.runId).toBeTruthy();

    // ── 5. Claim job as official runner via API ──
    // The run was dispatched to runner_job_queue (RUNNER_DEFAULT_GROUP=vm0/default).
    // Official runner token = vm0_official_<OFFICIAL_RUNNER_SECRET>
    const officialRunnerToken = `vm0_official_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`;
    const claimRes = await claimJobRoute(
      createTestRequest(
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
    const executionContext = await claimRes.json();

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
    mockClerk({ userId: null });

    // 6a. Without ?org= → sandbox token has no orgId, request fails
    // (in production, runner also injects VM0_ACTIVE_ORG for this reason)
    const noOrgRes = await getAgentRoute(
      createTestRequest(`http://localhost:3000/api/zero/agents/${agent.name}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${executionContext.sandboxToken}`,
        },
      }),
    );
    expect(noOrgRes.ok).toBe(false);

    // 6b. With ?org= (simulating VM0_ACTIVE_ORG) → should succeed
    const getRes = await getAgentRoute(
      createTestRequest(
        `http://localhost:3000/api/zero/agents/${agent.name}?org=${orgSlug}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${executionContext.sandboxToken}`,
          },
        },
      ),
    );
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.name).toBe(agent.name);
    expect(fetched.agentComposeId).toBe(agent.agentComposeId);
    expect(fetched.displayName).toBe("E2E Agent");
    expect(fetched.description).toBe("Created for sandbox token test");
  });
});
