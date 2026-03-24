import { describe, it, expect, beforeEach } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestZeroAgent,
  getTestZeroAgentId,
} from "../../../__tests__/api-test-helpers";
import { resolveComposeByAgentId } from "../schedule-service";

const context = testContext();

describe("resolveComposeByAgentId", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should resolve compose from a valid agentId", async () => {
    const agentName = uniqueId("resolve-ok");
    await createTestCompose(agentName);
    await createTestZeroAgent(user.orgId, agentName, {});
    const agentId = await getTestZeroAgentId(user.orgId, agentName);

    const compose = await resolveComposeByAgentId(agentId);

    expect(compose).not.toBeNull();
    expect(compose!.name).toBe(agentName);
    expect(compose!.orgId).toBe(user.orgId);
  });

  it("should return null when agent does not exist", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    const compose = await resolveComposeByAgentId(nonExistentId);

    expect(compose).toBeNull();
  });

  it("should return null when agent exists but compose does not", async () => {
    const agentName = uniqueId("no-compose");
    // Create zero agent without a matching compose
    await createTestZeroAgent(user.orgId, agentName, {});
    const agentId = await getTestZeroAgentId(user.orgId, agentName);

    const compose = await resolveComposeByAgentId(agentId);

    expect(compose).toBeNull();
  });
});
