import { describe, it, expect, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";
import { POST as postSkill } from "../../../route";
import { PATCH as patchSkillMd } from "../route";
import {
  createTestRequest,
  createTestCliToken,
  insertOrgMembersCacheEntry,
  createTestTarFile,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";

const context = testContext();

let user: UserContext;
let testCliToken: string;

const BLOCK_SIZE = 512;

/**
 * Build a multi-file tar archive (no compression) for tests.
 * We piggyback on createTestTarFile to build per-file blocks, strip each
 * archive's end-of-archive marker, then add a single end marker at the end.
 */
function createMultiFileTar(
  files: Array<{ path: string; content: string }>,
): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const single = createTestTarFile(f.path, Buffer.from(f.content, "utf-8"));
    // Strip the trailing 2x BLOCK_SIZE end-of-archive markers.
    parts.push(single.subarray(0, single.length - BLOCK_SIZE * 2));
  }
  parts.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
  return Buffer.concat(parts);
}

function postSkillReq(body: Record<string, unknown>, token: string) {
  return postSkill(
    createTestRequest(`http://localhost:3000/api/zero/skills`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

function patchSkillMdReq(
  name: string,
  body: Record<string, unknown>,
  token: string,
) {
  return patchSkillMd(
    createTestRequest(
      `http://localhost:3000/api/zero/skills/${name}/skill-md`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

function singleFile(content: string) {
  return [{ path: "SKILL.md", content }];
}

/**
 * Mock the tarball + manifest the route reads on PATCH to discover existing
 * files. The post-upload manifest (used to build the response) is also mocked
 * — both downloadS3Buffer and downloadManifest are queued with mockResolvedValueOnce.
 */
function mockExistingArchive(files: Array<{ path: string; content: string }>) {
  const tarBuffer = createMultiFileTar(files);
  const gzipped = gzipSync(tarBuffer);
  context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(gzipped);

  const manifestFiles = files.map((f) => {
    return {
      path: f.path,
      hash: "h_" + f.path,
      size: Buffer.byteLength(f.content, "utf-8"),
    };
  });
  context.mocks.s3.downloadManifest.mockResolvedValueOnce({
    version: "v",
    createdAt: new Date().toISOString(),
    totalSize: manifestFiles.reduce((s, f) => {
      return s + f.size;
    }, 0),
    fileCount: manifestFiles.length,
    files: manifestFiles,
  });
}

/**
 * Find the manifest payload that uploadSkillServerSide just wrote
 * (the second putS3Object call per upload — first is archive.tar.gz).
 */
function lastUploadedManifest(): {
  files: Array<{ path: string; size: number }>;
} {
  const calls = context.mocks.s3.putS3Object.mock.calls;
  // putS3Object is called twice per upload (archive + manifest); manifest is JSON.
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (!call) continue;
    const key = call[1];
    const body = call[2];
    if (key.endsWith("/manifest.json")) {
      const text =
        typeof body === "string"
          ? body
          : Buffer.isBuffer(body)
            ? body.toString("utf-8")
            : String(body);
      return JSON.parse(text);
    }
  }
  throw new Error("No manifest.json upload found");
}

describe("PATCH /api/zero/skills/:name/skill-md", () => {
  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    testCliToken = await createTestCliToken(user.userId);
  });

  it("replaces SKILL.md content for a single-file skill", async () => {
    await postSkillReq(
      { name: "single", files: singleFile("# Original") },
      testCliToken,
    );

    mockExistingArchive([{ path: "SKILL.md", content: "# Original" }]);

    const response = await patchSkillMdReq(
      "single",
      { content: "# Updated content" },
      testCliToken,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.name).toBe("single");
    expect(data.content).toBe("# Updated content");

    const manifest = lastUploadedManifest();
    expect(
      manifest.files
        .map((f) => {
          return f.path;
        })
        .sort(),
    ).toEqual(["SKILL.md"]);
  });

  it("preserves non-SKILL.md files in a multi-file skill", async () => {
    await postSkillReq(
      {
        name: "multi",
        files: [
          { path: "SKILL.md", content: "# Original" },
          { path: "templates/prompt.md", content: "tmpl-body" },
          { path: "data/sample.txt", content: "sample-data" },
        ],
      },
      testCliToken,
    );

    mockExistingArchive([
      { path: "SKILL.md", content: "# Original" },
      { path: "templates/prompt.md", content: "tmpl-body" },
      { path: "data/sample.txt", content: "sample-data" },
    ]);

    const response = await patchSkillMdReq(
      "multi",
      { content: "# Updated SKILL only" },
      testCliToken,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.content).toBe("# Updated SKILL only");

    const manifest = lastUploadedManifest();
    const paths = manifest.files
      .map((f) => {
        return f.path;
      })
      .sort();
    expect(paths).toEqual([
      "SKILL.md",
      "data/sample.txt",
      "templates/prompt.md",
    ]);
  });

  it("updates optional displayName and description in the same call", async () => {
    await postSkillReq(
      {
        name: "metaedit",
        files: singleFile("# Body"),
        displayName: "Old name",
        description: "Old desc",
      },
      testCliToken,
    );

    mockExistingArchive([{ path: "SKILL.md", content: "# Body" }]);

    const response = await patchSkillMdReq(
      "metaedit",
      {
        content: "# Body",
        displayName: "New name",
        description: "New desc",
      },
      testCliToken,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.displayName).toBe("New name");
    expect(data.description).toBe("New desc");
  });

  it("returns 404 for an unknown skill", async () => {
    const response = await patchSkillMdReq(
      "no-such",
      { content: "# x" },
      testCliToken,
    );
    expect(response.status).toBe(404);
  });

  it("returns 403 when called by a non-admin org member", async () => {
    const orgId = `org_mock_${user.userId}`;
    await insertOrgMembersCacheEntry({
      orgId,
      userId: user.userId,
      role: "admin",
    });
    await postSkillReq(
      { name: "for-member", files: singleFile("# Body") },
      testCliToken,
    );

    const memberUserId = `member-${Date.now()}`;
    const memberToken = await createTestCliToken(
      memberUserId,
      undefined,
      orgId,
    );
    await insertOrgMembersCacheEntry({
      orgId,
      userId: memberUserId,
      role: "member",
    });

    const response = await patchSkillMdReq(
      "for-member",
      { content: "# Edit" },
      memberToken,
    );
    expect(response.status).toBe(403);
  });

  it("rejects content that exceeds the 5MB limit with 400", async () => {
    const big = "x".repeat(5 * 1024 * 1024 + 1);

    const response = await patchSkillMdReq(
      "anything",
      { content: big },
      testCliToken,
    );
    // Body schema validation rejects oversize content before route logic runs.
    expect(response.status).toBe(400);
  });
});
