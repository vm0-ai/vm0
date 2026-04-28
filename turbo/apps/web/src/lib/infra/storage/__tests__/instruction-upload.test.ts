import { describe, it, expect, vi, beforeEach } from "vitest";
import { gunzipSync } from "node:zlib";
import { testContext } from "../../../../__tests__/test-helpers";
import { uploadInstructionsServerSide } from "../instruction-upload";
import { extractFileFromTar } from "../../tar";

vi.hoisted(() => {
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-storages-bucket");
});

const context = testContext();

describe("uploadInstructionsServerSide", () => {
  let orgId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    orgId = user.orgId;
  });

  it("should upload new instructions and return correct result", async () => {
    const result = await uploadInstructionsServerSide({
      orgId,
      agentName: "my-agent",
      content: "# Instructions\nDo the thing.",
    });

    expect(result.storageName).toBe("agent-instructions@my-agent");
    expect(result.versionId).toMatch(/^[a-f0-9]{64}$/);

    // Verify putS3Object called twice (archive + manifest)
    expect(context.mocks.s3.putS3Object).toHaveBeenCalledTimes(2);

    // Verify archive upload
    const archiveCall = context.mocks.s3.putS3Object.mock.calls.find((c) => {
      return typeof c[1] === "string" && c[1].endsWith("/archive.tar.gz");
    });
    expect(archiveCall).toBeDefined();
    expect(archiveCall![2]).toBeInstanceOf(Buffer);
    expect(archiveCall![3]).toBe("application/gzip");

    // Verify manifest upload
    const manifestCall = context.mocks.s3.putS3Object.mock.calls.find((c) => {
      return typeof c[1] === "string" && c[1].endsWith("/manifest.json");
    });
    expect(manifestCall).toBeDefined();
    expect(manifestCall![3]).toBe("application/json");

    // Verify manifest content
    const manifestBody = JSON.parse(manifestCall![2] as string);
    expect(manifestBody.version).toBe(result.versionId);
    expect(manifestBody.fileCount).toBe(1);
    expect(manifestBody.files).toHaveLength(1);
    expect(manifestBody.files[0].path).toBe("CLAUDE.md");
    expect(manifestBody.files[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifestBody.files[0].size).toBeGreaterThan(0);
  });

  it("should store raw content without metadata injection", async () => {
    const result = await uploadInstructionsServerSide({
      orgId,
      agentName: "meta-agent",
      content: "# Instructions",
    });

    expect(result.storageName).toBe("agent-instructions@meta-agent");

    // Extract the archive content and verify no metadata was injected
    const archiveCall = context.mocks.s3.putS3Object.mock.calls.find((c) => {
      return typeof c[1] === "string" && c[1].endsWith("/archive.tar.gz");
    });
    expect(archiveCall).toBeDefined();

    const archiveBuffer = archiveCall![2] as Buffer;
    const tarBuffer = gunzipSync(archiveBuffer);
    const fileContent = extractFileFromTar(tarBuffer, "CLAUDE.md");
    expect(fileContent).not.toBeNull();

    const text = fileContent!.toString("utf-8");
    expect(text).not.toContain("[AGENT_PROFILE]");
    expect(text).toBe("# Instructions");
  });

  it("should deduplicate when same content is uploaded twice", async () => {
    const params = {
      orgId,
      agentName: "dedup-agent",
      content: "# Same content",
    };

    // First upload — no existing version in DB, so verifyS3FilesExist is never
    // reached. Set it to false to make the mock state explicit.
    context.mocks.s3.verifyS3FilesExist.mockResolvedValue(false);
    const result1 = await uploadInstructionsServerSide(params);
    expect(context.mocks.s3.putS3Object).toHaveBeenCalledTimes(2);

    // Second upload — existing version found in DB, verifyS3FilesExist is
    // called and returns true so the S3 upload is skipped (dedup).
    context.mocks.s3.verifyS3FilesExist.mockResolvedValue(true);
    const result2 = await uploadInstructionsServerSide(params);

    expect(result2.versionId).toBe(result1.versionId);
    expect(result2.storageName).toBe(result1.storageName);

    // putS3Object should NOT have been called again (still 2 from first upload)
    expect(context.mocks.s3.putS3Object).toHaveBeenCalledTimes(2);
  });

  it("uploads codex instructions as AGENTS.md when framework=codex", async () => {
    const result = await uploadInstructionsServerSide({
      orgId,
      agentName: "codex-agent",
      content: "# Codex instructions",
      framework: "codex",
    });

    expect(result.storageName).toBe("agent-instructions@codex-agent");

    const archiveCall = context.mocks.s3.putS3Object.mock.calls.find((c) => {
      return typeof c[1] === "string" && c[1].endsWith("/archive.tar.gz");
    });
    expect(archiveCall).toBeDefined();
    const tarBuffer = gunzipSync(archiveCall![2] as Buffer);
    const fileContent = extractFileFromTar(tarBuffer, "AGENTS.md");
    expect(fileContent).not.toBeNull();
    expect(fileContent!.toString("utf-8")).toBe("# Codex instructions");

    const manifestCall = context.mocks.s3.putS3Object.mock.calls.find((c) => {
      return typeof c[1] === "string" && c[1].endsWith("/manifest.json");
    });
    expect(manifestCall).toBeDefined();
    const manifestBody = JSON.parse(manifestCall![2] as string);
    expect(manifestBody.files).toHaveLength(1);
    expect(manifestBody.files[0].path).toBe("AGENTS.md");
  });

  it("should return different versionId for different content", async () => {
    const resultA = await uploadInstructionsServerSide({
      orgId,
      agentName: "version-agent",
      content: "# Content A",
    });

    const resultB = await uploadInstructionsServerSide({
      orgId,
      agentName: "version-agent",
      content: "# Content B",
    });

    // Different content produces different version IDs
    expect(resultB.versionId).not.toBe(resultA.versionId);
    // Same storage name since same agent
    expect(resultB.storageName).toBe(resultA.storageName);
    // putS3Object called 4 times total (2 per upload)
    expect(context.mocks.s3.putS3Object).toHaveBeenCalledTimes(4);
  });
});
