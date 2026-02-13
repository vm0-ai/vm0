import { describe, it, expect, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";
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

/**
 * Build a gzipped tar archive containing a single file.
 * The route downloads archive.tar.gz, decompresses, and extracts from tar.
 */
function buildTarGz(filename: string, content: string): Buffer {
  const contentBuf = Buffer.from(content, "utf-8");

  // Tar header: 512 bytes
  const header = Buffer.alloc(512);
  // File name at offset 0 (up to 100 bytes)
  header.write(filename, 0, Math.min(filename.length, 100), "utf-8");
  // File mode at offset 100 (8 bytes, octal)
  header.write("0000644\0", 100, 8, "utf-8");
  // Owner/group IDs at offsets 108, 116 (8 bytes each, octal)
  header.write("0000000\0", 108, 8, "utf-8");
  header.write("0000000\0", 116, 8, "utf-8");
  // File size at offset 124 (12 bytes, octal, null-terminated)
  const sizeOctal = contentBuf.length.toString(8).padStart(11, "0");
  header.write(sizeOctal + "\0", 124, 12, "utf-8");
  // Modification time at offset 136 (12 bytes, octal)
  const mtime = Math.floor(Date.now() / 1000)
    .toString(8)
    .padStart(11, "0");
  header.write(mtime + "\0", 136, 12, "utf-8");
  // Type flag at offset 156: '0' = regular file
  header.write("0", 156, 1, "utf-8");

  // Compute checksum: fill checksum field (offset 148, 8 bytes) with spaces first
  header.write("        ", 148, 8, "utf-8");
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i] ?? 0;
  }
  // Write checksum as 6-digit octal, null-terminated, space-padded
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");

  // Pad content to 512-byte boundary
  const paddingSize = (512 - (contentBuf.length % 512)) % 512;
  const padding = Buffer.alloc(paddingSize);

  // End-of-archive marker: two 512-byte zero blocks
  const endMarker = Buffer.alloc(1024);

  const tar = Buffer.concat([header, contentBuf, padding, endMarker]);
  return gzipSync(tar);
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
});
