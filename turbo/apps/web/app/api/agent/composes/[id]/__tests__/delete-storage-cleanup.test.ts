import { describe, it, expect, vi, beforeEach } from "vitest";
import { DELETE } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestVolume,
  findTestStorageByName,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { getInstructionsStorageName } from "@vm0/core";

vi.hoisted(() => {
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-storages-bucket");
});

const context = testContext();

describe("Delete Agent - Instructions Storage Cleanup", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should delete instructions volume when agent is deleted", async () => {
    const agentName = uniqueId("cleanup-agent");

    // Create agent and instructions volume
    const { composeId } = await createTestCompose(agentName);
    const storageName = getInstructionsStorageName(agentName);
    await createTestVolume(storageName);

    // Verify volume exists
    const storageBefore = await findTestStorageByName(
      user.scopeId,
      storageName,
    );
    expect(storageBefore).toBeDefined();

    // Delete agent
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}`,
      { method: "DELETE" },
    );
    const response = await DELETE(request);
    expect(response.status).toBe(204);

    // Instructions volume should be deleted
    const storageAfter = await findTestStorageByName(user.scopeId, storageName);
    expect(storageAfter).toBeUndefined();
  });

  it("should not fail when agent has no instructions volume", async () => {
    const agentName = uniqueId("no-volume-agent");

    // Create agent without instructions volume
    const { composeId } = await createTestCompose(agentName);

    // Delete agent — should succeed without error
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}`,
      { method: "DELETE" },
    );
    const response = await DELETE(request);
    expect(response.status).toBe(204);
  });

  it("should not delete skill volumes when agent is deleted", async () => {
    const agentName = uniqueId("skill-agent");

    // Create agent, instructions volume, and skill volume
    const { composeId } = await createTestCompose(agentName);
    const instructionsName = getInstructionsStorageName(agentName);
    await createTestVolume(instructionsName);
    const skillName = `agent-skills@test-org/test-repo/tree/main/test-skill`;
    await createTestVolume(skillName);

    // Delete agent
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}`,
      { method: "DELETE" },
    );
    const response = await DELETE(request);
    expect(response.status).toBe(204);

    // Instructions volume should be deleted
    const instructionsAfter = await findTestStorageByName(
      user.scopeId,
      instructionsName,
    );
    expect(instructionsAfter).toBeUndefined();

    // Skill volume should still exist
    const skillAfter = await findTestStorageByName(user.scopeId, skillName);
    expect(skillAfter).toBeDefined();
  });
});
