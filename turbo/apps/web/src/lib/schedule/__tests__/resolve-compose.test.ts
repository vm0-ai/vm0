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
import { resolveComposeByZeroAgentId } from "../schedule-service";

const context = testContext();

describe("resolveComposeByZeroAgentId", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should resolve compose from a valid zeroAgentId", async () => {
    const agentName = uniqueId("resolve-ok");
    await createTestCompose(agentName);
    await createTestZeroAgent(user.orgId, agentName, {});
    const zeroAgentId = await getTestZeroAgentId(user.orgId, agentName);

    const compose = await resolveComposeByZeroAgentId(zeroAgentId);

    expect(compose).not.toBeNull();
    expect(compose!.name).toBe(agentName);
    expect(compose!.orgId).toBe(user.orgId);
  });

  it("should return null when agent does not exist", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    const compose = await resolveComposeByZeroAgentId(nonExistentId);

    expect(compose).toBeNull();
  });

  it("should return null when agent exists but compose does not", async () => {
    const agentName = uniqueId("no-compose");
    // Create zero agent without a matching compose
    await createTestZeroAgent(user.orgId, agentName, {});
    const zeroAgentId = await getTestZeroAgentId(user.orgId, agentName);

    const compose = await resolveComposeByZeroAgentId(zeroAgentId);

    expect(compose).toBeNull();
  });
});
