import { describe, it, expect, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";
import { GET, PUT } from "../route";
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
import { createSingleFileTar } from "../../../../../../../src/lib/tar";

function buildTarGz(filename: string, content: string): Buffer {
  return gzipSync(createSingleFileTar(filename, Buffer.from(content, "utf-8")));
}

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

    // Mock manifest to describe the file in the archive
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

    // Mock downloadS3Buffer to return a gzipped tar archive containing the instructions
    context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(
      buildTarGz("AGENTS.md", instructionsContent),
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

    // Mock downloadS3Buffer to return a gzipped tar archive
    context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(
      buildTarGz("AGENTS.md", "# Shared Instructions"),
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

  it("should fall back to CLAUDE.md when configured filename not found in manifest", async () => {
    const agentName = "fallback-agent";
    const claudeContent = "# Legacy CLAUDE.md content\n";

    const { composeId } = await createTestCompose(agentName, {
      overrides: { instructions: "AGENTS.md" },
    });

    const storageName = getInstructionsStorageName(agentName);
    await createTestVolume(storageName);

    // Manifest only contains CLAUDE.md, not AGENTS.md
    context.mocks.s3.downloadManifest.mockResolvedValueOnce({
      version: "a".repeat(64),
      createdAt: new Date().toISOString(),
      totalSize: claudeContent.length,
      fileCount: 1,
      files: [
        {
          path: "CLAUDE.md",
          hash: "d".repeat(64),
          size: claudeContent.length,
        },
      ],
    });

    context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(
      buildTarGz("CLAUDE.md", claudeContent),
    );

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: composeId }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.content).toBe(claudeContent);
    expect(data.filename).toBe("AGENTS.md");
  });

  it("should normalize ./ prefix when matching instructions file in manifest", async () => {
    const agentName = "normalize-prefix-agent";
    const instructionsContent = "# Normalized content\n";

    const { composeId } = await createTestCompose(agentName, {
      overrides: { instructions: "AGENTS.md" },
    });

    const storageName = getInstructionsStorageName(agentName);
    await createTestVolume(storageName);

    // Manifest file has ./ prefix but config says "AGENTS.md" without prefix
    context.mocks.s3.downloadManifest.mockResolvedValueOnce({
      version: "a".repeat(64),
      createdAt: new Date().toISOString(),
      totalSize: instructionsContent.length,
      fileCount: 1,
      files: [
        {
          path: "./AGENTS.md",
          hash: "e".repeat(64),
          size: instructionsContent.length,
        },
      ],
    });

    context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(
      buildTarGz("./AGENTS.md", instructionsContent),
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
});

describe("PUT /api/agent/composes/:id/instructions", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/some-id/instructions",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "new content" }),
      },
    );
    const response = await PUT(request, {
      params: Promise.resolve({ id: "some-id" }),
    });
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 403 for non-owner", async () => {
    // Owner creates agent
    await context.setupUser({ prefix: "owner" });
    const { composeId } = await createTestCompose("owned-agent", {
      overrides: { instructions: "AGENTS.md" },
    });

    // Share with original user
    await createTestPermission(composeId, "email", MOCK_USER_EMAIL);

    // Switch to the shared (non-owner) user
    mockClerk({ userId: user.userId });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hacked" }),
      },
    );
    const response = await PUT(request, {
      params: Promise.resolve({ id: composeId }),
    });
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("should save instructions and create storage version", async () => {
    const agentName = "editable-agent";
    const { composeId } = await createTestCompose(agentName, {
      overrides: { instructions: "AGENTS.md" },
    });

    const newContent = "# Updated Instructions\n\nNew content here.\n";
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent }),
      },
    );
    const response = await PUT(request, {
      params: Promise.resolve({ id: composeId }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);

    // Verify S3 uploads were called (manifest + archive)
    expect(context.mocks.s3.putS3Object).toHaveBeenCalledTimes(2);

    // Verify manifest upload
    const manifestCall = context.mocks.s3.putS3Object.mock.calls.find(
      (call) =>
        typeof call[1] === "string" && call[1].endsWith("/manifest.json"),
    );
    expect(manifestCall).toBeDefined();

    // Verify archive upload
    const archiveCall = context.mocks.s3.putS3Object.mock.calls.find(
      (call) =>
        typeof call[1] === "string" && call[1].endsWith("/archive.tar.gz"),
    );
    expect(archiveCall).toBeDefined();
  });

  it("should return 400 when content is missing", async () => {
    const { composeId } = await createTestCompose("bad-request-agent", {
      overrides: { instructions: "AGENTS.md" },
    });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await PUT(request, {
      params: Promise.resolve({ id: composeId }),
    });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return 404 for non-existent compose", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${fakeId}/instructions`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "new content" }),
      },
    );
    const response = await PUT(request, {
      params: Promise.resolve({ id: fakeId }),
    });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 413 when content exceeds 1 MB", async () => {
    const { composeId } = await createTestCompose("large-content-agent", {
      overrides: { instructions: "AGENTS.md" },
    });

    // Create content just over 1 MB
    const largeContent = "x".repeat(1024 * 1024 + 1);
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: largeContent }),
      },
    );
    const response = await PUT(request, {
      params: Promise.resolve({ id: composeId }),
    });
    const data = await response.json();

    expect(response.status).toBe(413);
    expect(data.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("should return 400 when compose has no agents configured", async () => {
    // Create compose without any agent definitions (no instructions)
    const { composeId } = await createTestCompose("no-agents-agent");

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "new content" }),
      },
    );
    const response = await PUT(request, {
      params: Promise.resolve({ id: composeId }),
    });
    const data = await response.json();

    // The compose has agents in the config but no instructions field,
    // so this returns 400 with "No instructions file configured"
    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should allow writing then reading back instructions", async () => {
    const agentName = "roundtrip-agent";
    const { composeId } = await createTestCompose(agentName, {
      overrides: { instructions: "AGENTS.md" },
    });

    const newContent =
      "# Round-trip Test\n\nThis content was written via PUT.\n";

    // PUT the instructions
    const putRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent }),
      },
    );
    const putResponse = await PUT(putRequest, {
      params: Promise.resolve({ id: composeId }),
    });
    const putData = await putResponse.json();

    expect(putResponse.status).toBe(200);
    expect(putData.success).toBe(true);

    // Capture the S3 key from the PUT call to set up GET mocks
    const manifestCall = context.mocks.s3.putS3Object.mock.calls.find(
      (call) =>
        typeof call[1] === "string" && call[1].endsWith("/manifest.json"),
    );
    const manifestBody = JSON.parse(manifestCall![2] as string);

    // Mock GET to return what was PUT
    context.mocks.s3.downloadManifest.mockResolvedValueOnce(manifestBody);
    context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(
      buildTarGz("AGENTS.md", newContent),
    );

    // GET the instructions back
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
    );
    const getResponse = await GET(getRequest, {
      params: Promise.resolve({ id: composeId }),
    });
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.content).toBe(newContent);
    expect(getData.filename).toBe("AGENTS.md");
  });
});
