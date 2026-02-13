import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestVolume,
  createTestPermission,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import {
  mockClerk,
  MOCK_USER_EMAIL,
} from "../../../../../../../src/__tests__/clerk-mock";
import { getInstructionsStorageName } from "@vm0/core";

const context = testContext();

describe("GET /api/agent/composes/:id/instructions", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/some-id/instructions",
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: "some-id" }),
    });
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 for non-existent compose", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${fakeId}/instructions`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: fakeId }),
    });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return null content when compose has no instructions", async () => {
    // Create compose without instructions field
    const { composeId } = await createTestCompose("no-instructions-agent");

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: composeId }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.content).toBeNull();
    expect(data.filename).toBeNull();
  });

  it("should return null content when instructions volume does not exist", async () => {
    // Create compose WITH instructions field but no storage volume
    const { composeId } = await createTestCompose("has-instructions-agent", {
      overrides: { instructions: "AGENTS.md" },
    });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: composeId }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.content).toBeNull();
    expect(data.filename).toBe("AGENTS.md");
  });

  it("should return instructions content when volume exists", async () => {
    const agentName = "instructions-test-agent";
    const instructionsContent = "# My Agent\n\nDo the thing.\n";

    // Create compose with instructions field
    const { composeId } = await createTestCompose(agentName, {
      overrides: { instructions: "AGENTS.md" },
    });

    // Create the instructions storage volume
    const storageName = getInstructionsStorageName(agentName);
    await createTestVolume(storageName);

    // Configure centralized S3 mocks for this test
    context.mocks.s3.downloadManifest.mockResolvedValueOnce({
      version: "a".repeat(64),
      createdAt: new Date().toISOString(),
      totalSize: instructionsContent.length,
      fileCount: 1,
      files: [
        {
          path: "AGENTS.md",
          hash: "b".repeat(64),
          size: instructionsContent.length,
        },
      ],
    });

    context.mocks.s3.downloadBlob.mockResolvedValueOnce(
      Buffer.from(instructionsContent),
    );

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: composeId }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.content).toBe(instructionsContent);
    expect(data.filename).toBe("AGENTS.md");
  });

  it("should allow shared users to read instructions", async () => {
    // Owner creates agent with instructions
    await context.setupUser({ prefix: "owner" });
    const agentName = "shared-instructions-agent";

    const { composeId } = await createTestCompose(agentName, {
      overrides: { instructions: "AGENTS.md" },
    });

    // Share with original user
    await createTestPermission(composeId, "email", MOCK_USER_EMAIL);

    // Create storage volume
    const storageName = getInstructionsStorageName(agentName);
    await createTestVolume(storageName);

    // Switch to the shared user
    mockClerk({ userId: user.userId });

    context.mocks.s3.downloadManifest.mockResolvedValueOnce({
      version: "a".repeat(64),
      createdAt: new Date().toISOString(),
      totalSize: 50,
      fileCount: 1,
      files: [{ path: "AGENTS.md", hash: "c".repeat(64), size: 50 }],
    });

    context.mocks.s3.downloadBlob.mockResolvedValueOnce(
      Buffer.from("# Shared Instructions"),
    );

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: composeId }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.content).toBe("# Shared Instructions");
    expect(data.filename).toBe("AGENTS.md");
  });

  it("should return 404 for non-shared user", async () => {
    // Owner creates agent
    await context.setupUser({ prefix: "private-owner" });
    const { composeId } = await createTestCompose("private-agent", {
      overrides: { instructions: "AGENTS.md" },
    });

    // Switch to original user (not shared)
    mockClerk({ userId: user.userId });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: composeId }),
    });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });
});
