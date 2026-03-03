import { describe, it, expect, beforeEach } from "vitest";
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

const context = testContext();

describe("Delete Agent - Instructions Storage Cleanup", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should delete instructions volume and S3 objects when agent is deleted", async () => {
    const agentName = uniqueId("cleanup-agent");

    // Create agent and instructions volume
    const { composeId } = await createTestCompose(agentName);
    const storageName = getInstructionsStorageName(agentName);
    await createTestVolume(storageName);

    // Verify volume exists and get its s3Prefix
    const storageBefore = await findTestStorageByName(
      user.scopeId,
      storageName,
    );
    expect(storageBefore).toBeDefined();
    const { s3Prefix } = storageBefore!;

    // Configure listS3Objects to return mock objects for the storage prefix
    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: `${s3Prefix}/v1/archive.tar.gz`, size: 1024 },
      { key: `${s3Prefix}/v1/manifest.json`, size: 256 },
    ]);

    // Delete agent
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}`,
      { method: "DELETE" },
    );
    const response = await DELETE(request);
    expect(response.status).toBe(204);

    // Instructions volume should be deleted from DB
    const storageAfter = await findTestStorageByName(user.scopeId, storageName);
    expect(storageAfter).toBeUndefined();

    // S3 objects should be listed and deleted
    expect(context.mocks.s3.listS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      s3Prefix,
    );
    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [`${s3Prefix}/v1/archive.tar.gz`, `${s3Prefix}/v1/manifest.json`],
    );
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
