import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestVolume,
  findTestStorageByName,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { getInstructionsStorageName } from "@vm0/core";

vi.hoisted(() => {
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-storages-bucket");
});

const context = testContext();

describe("Storage Volume Migration on Agent Rename", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should rename instructions volume when agent is renamed", async () => {
    const oldName = `old-agent-${Date.now()}`;
    const newName = `new-agent-${Date.now()}`;

    // Create the original agent compose
    await createTestCompose(oldName);

    // Create the instructions volume for the old agent
    const oldStorageName = getInstructionsStorageName(oldName);
    await createTestVolume(oldStorageName);

    // Rename the agent by posting with previousName
    const config = {
      version: "1.0",
      agents: {
        [newName]: { framework: "claude-code" },
      },
    };

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config, previousName: oldName }),
      },
    );

    const response = await POST(request);
    // 201 because the new agent name creates a new compose entry
    expect(response.status).toBe(201);

    // Old storage name should no longer exist
    const newStorageName = getInstructionsStorageName(newName);

    const oldStorage = await findTestStorageByName(
      user.scopeId,
      oldStorageName,
    );
    expect(oldStorage).toBeUndefined();

    // New storage name should exist
    const newStorage = await findTestStorageByName(
      user.scopeId,
      newStorageName,
    );
    expect(newStorage).toBeDefined();
  });

  it("should delete conflicting storage before renaming", async () => {
    const oldName = `conflict-old-${Date.now()}`;
    const newName = `conflict-new-${Date.now()}`;

    // Create old agent + volume
    await createTestCompose(oldName);
    const oldStorageName = getInstructionsStorageName(oldName);
    await createTestVolume(oldStorageName);

    // Create a conflicting volume with the new name (e.g. from a previously deleted agent)
    const newStorageName = getInstructionsStorageName(newName);
    await createTestVolume(newStorageName);

    // Remember the old storage's ID — after rename it should have the new name
    const oldStorageBefore = await findTestStorageByName(
      user.scopeId,
      oldStorageName,
    );
    expect(oldStorageBefore).toBeDefined();
    const oldStorageId = oldStorageBefore!.id;

    // Rename
    const config = {
      version: "1.0",
      agents: {
        [newName]: { framework: "claude-code" },
      },
    };

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config, previousName: oldName }),
      },
    );

    const response = await POST(request);
    // 201 because the new agent name creates a new compose entry
    expect(response.status).toBe(201);

    // The renamed storage should have the old storage's ID
    const renamedStorage = await findTestStorageByName(
      user.scopeId,
      newStorageName,
    );
    expect(renamedStorage).toBeDefined();
    expect(renamedStorage!.id).toBe(oldStorageId);

    // Old name should no longer exist
    const oldStorageAfter = await findTestStorageByName(
      user.scopeId,
      oldStorageName,
    );
    expect(oldStorageAfter).toBeUndefined();
  });

  it("should not migrate when previousName equals new name", async () => {
    const agentName = `same-name-agent-${Date.now()}`;

    // Create agent + volume
    await createTestCompose(agentName);
    const storageName = getInstructionsStorageName(agentName);
    await createTestVolume(storageName);

    const storageBefore = await findTestStorageByName(
      user.scopeId,
      storageName,
    );
    expect(storageBefore).toBeDefined();

    // "Rename" with same name — should be a no-op for storage
    const config = {
      version: "1.0",
      agents: {
        [agentName]: {
          framework: "claude-code",
          description: "updated",
        },
      },
    };

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config, previousName: agentName }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    // Storage should still exist with the same name and ID
    const storageAfter = await findTestStorageByName(user.scopeId, storageName);
    expect(storageAfter).toBeDefined();
    expect(storageAfter!.id).toBe(storageBefore!.id);
  });

  it("should handle rename when no instructions volume exists", async () => {
    const oldName = `no-volume-old-${Date.now()}`;
    const newName = `no-volume-new-${Date.now()}`;

    // Create old agent but no instructions volume
    await createTestCompose(oldName);

    // Rename
    const config = {
      version: "1.0",
      agents: {
        [newName]: { framework: "claude-code" },
      },
    };

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config, previousName: oldName }),
      },
    );

    const response = await POST(request);
    // 201 because the new agent name creates a new compose entry
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.name).toBe(newName);
  });
});
