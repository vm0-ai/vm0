import { describe, it, expect, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestVolume,
  insertOrgMembersCacheEntry,
  createTestTarFile,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { getInstructionsStorageName } from "@vm0/core";

function buildTarGz(filename: string, content: string): Buffer {
  return gzipSync(createTestTarFile(filename, Buffer.from(content, "utf-8")));
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
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 for non-existent compose", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${fakeId}/instructions`,
    );
    const response = await GET(request);
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
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.content).toBeNull();
    // Even without an explicit instructions field, the framework-canonical
    // filename is returned (CLAUDE.md for claude-code) because the CLI may
    // upload instructions without setting the field in the YAML.
    expect(data.filename).toBe("CLAUDE.md");
  });

  it("should return null content when instructions volume does not exist", async () => {
    // Create compose WITH instructions field but no storage volume
    const { composeId } = await createTestCompose("has-instructions-agent", {
      overrides: { instructions: "AGENTS.md" },
    });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.content).toBeNull();
    expect(data.filename).toBe("AGENTS.md");
  });

  it("should return instructions content when volume exists", async () => {
    const agentName = "instructions-test-agent";
    const instructionsContent = "# My Agent\n\nDo the thing.\n";

    // Create compose with instructions field (framework defaults to claude-code)
    const { composeId } = await createTestCompose(agentName, {
      overrides: { instructions: "AGENTS.md" },
    });

    // Create the instructions storage volume
    const storageName = getInstructionsStorageName(agentName);
    await createTestVolume(storageName);

    // Mock manifest with CLAUDE.md — the canonical filename for claude-code framework.
    // CLI uploads instructions with the framework-canonical name, not the user's filename.
    context.mocks.s3.downloadManifest.mockResolvedValueOnce({
      version: "a".repeat(64),
      createdAt: new Date().toISOString(),
      totalSize: instructionsContent.length,
      fileCount: 1,
      files: [
        {
          path: "CLAUDE.md",
          hash: "b".repeat(64),
          size: instructionsContent.length,
        },
      ],
    });

    context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(
      buildTarGz("CLAUDE.md", instructionsContent),
    );

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.content).toBe(instructionsContent);
    // filename in response is from compose YAML (what frontend displays)
    expect(data.filename).toBe("AGENTS.md");
  });

  it("should allow shared users to read instructions", async () => {
    // Owner creates agent with instructions
    const owner = await context.setupUser({ prefix: "owner" });
    const agentName = "shared-instructions-agent";

    const { composeId } = await createTestCompose(agentName, {
      overrides: { instructions: "AGENTS.md" },
    });

    // Grant org membership to the original user
    await insertOrgMembersCacheEntry({
      orgId: owner.orgId,
      userId: user.userId,
      cachedAt: new Date(),
    });

    // Create storage volume
    const storageName = getInstructionsStorageName(agentName);
    await createTestVolume(storageName);

    // Switch to the org member user with active org set to the owner's org
    // (compose access is scoped to the caller's active org)
    mockClerk({ userId: user.userId, orgId: owner.orgId });

    context.mocks.s3.downloadManifest.mockResolvedValueOnce({
      version: "a".repeat(64),
      createdAt: new Date().toISOString(),
      totalSize: 50,
      fileCount: 1,
      files: [{ path: "CLAUDE.md", hash: "c".repeat(64), size: 50 }],
    });

    context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(
      buildTarGz("CLAUDE.md", "# Shared Instructions"),
    );

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
    );
    const response = await GET(request);
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
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should find instructions by framework canonical filename regardless of compose YAML filename", async () => {
    const agentName = "framework-lookup-agent";
    const claudeContent = "# Instructions via framework lookup\n";

    // Compose YAML says "AGENTS.md" but framework is claude-code,
    // so CLI uploaded as "CLAUDE.md". The API should derive the canonical
    // filename from the framework and find it in the manifest.
    const { composeId } = await createTestCompose(agentName, {
      overrides: { instructions: "AGENTS.md" },
    });

    const storageName = getInstructionsStorageName(agentName);
    await createTestVolume(storageName);

    // Manifest contains CLAUDE.md (canonical for claude-code framework)
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
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.content).toBe(claudeContent);
    // filename in response is still from compose YAML (what the frontend displays)
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

    // Manifest file has ./ prefix (e.g., ./CLAUDE.md) — should still match
    // the canonical filename CLAUDE.md after normalization
    context.mocks.s3.downloadManifest.mockResolvedValueOnce({
      version: "a".repeat(64),
      createdAt: new Date().toISOString(),
      totalSize: instructionsContent.length,
      fileCount: 1,
      files: [
        {
          path: "./CLAUDE.md",
          hash: "e".repeat(64),
          size: instructionsContent.length,
        },
      ],
    });

    context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(
      buildTarGz("./CLAUDE.md", instructionsContent),
    );

    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.content).toBe(instructionsContent);
    expect(data.filename).toBe("AGENTS.md");
  });
});
