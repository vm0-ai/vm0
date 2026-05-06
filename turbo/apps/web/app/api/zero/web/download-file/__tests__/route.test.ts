import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import {
  generateZeroToken,
  generateSandboxToken,
} from "../../../../../../src/lib/auth/sandbox-token";

const URL = "http://localhost:3000/api/zero/web/download-file";

const context = testContext();

describe("GET /api/zero/web/download-file", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  async function authedRequest(fileId: string): Promise<Request> {
    mockClerk({ userId: null });
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);
    return createTestRequest(`${URL}?file_id=${fileId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("returns 401 when no auth token provided", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(`${URL}?file_id=abc`, { method: "GET" });
    const response = await GET(request as never);

    expect(response.status).toBe(401);
  });

  it("returns 401 for sandbox token without file:read capability", async () => {
    mockClerk({ userId: null });
    const token = await generateSandboxToken(user.userId, "run-1", "org-test");

    const request = createTestRequest(`${URL}?file_id=abc`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const response = await GET(request as never);

    expect(response.status).toBe(401);
  });

  it("returns 400 when file_id query param is missing", async () => {
    mockClerk({ userId: null });
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);
    const noIdRequest = createTestRequest(URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const response = await GET(noIdRequest as never);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 when file not found in S3", async () => {
    // listS3Objects returns [] by default
    const request = await authedRequest("nonexistent-id");
    const response = await GET(request as never);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("downloads file and returns correct headers", async () => {
    const fileId = "test-file-uuid";
    const fileContent = Buffer.from("hello world");
    const s3Key = `uploads/${user.userId}/${fileId}/test_file.txt`;

    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: s3Key, size: fileContent.length },
    ]);
    context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(fileContent);

    const request = await authedRequest(fileId);
    const response = await GET(request as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("x-file-name")).toBe("test_file.txt");
    expect(response.headers.get("x-file-mimetype")).toBe("text/plain");
    expect(response.headers.get("content-length")).toBe(
      String(fileContent.length),
    );

    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileContent)).toBe(true);
  });

  it("downloads image file with correct mimetype", async () => {
    const fileId = "img-uuid";
    const fileContent = Buffer.from("fake-png-data");
    const s3Key = `uploads/${user.userId}/${fileId}/photo.png`;

    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: s3Key, size: fileContent.length },
    ]);
    context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(fileContent);

    const request = await authedRequest(fileId);
    const response = await GET(request as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-file-mimetype")).toBe("image/png");
  });

  it("downloads office file with correct mimetype", async () => {
    const fileId = "sheet-uuid";
    const fileContent = Buffer.from("fake-xlsx-data");
    const s3Key = `uploads/${user.userId}/${fileId}/budget.xlsx`;

    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: s3Key, size: fileContent.length },
    ]);
    context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(fileContent);

    const request = await authedRequest(fileId);
    const response = await GET(request as never);

    const expected =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(expected);
    expect(response.headers.get("x-file-mimetype")).toBe(expected);
  });

  it("returns application/octet-stream for unknown extensions", async () => {
    const fileId = "bin-uuid";
    const fileContent = Buffer.from("binary-data");
    const s3Key = `uploads/${user.userId}/${fileId}/data.xyz`;

    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: s3Key, size: fileContent.length },
    ]);
    context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(fileContent);

    const request = await authedRequest(fileId);
    const response = await GET(request as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
  });

  it("scopes file lookup to the authenticated user", async () => {
    const fileId = "scoped-uuid";

    context.mocks.s3.listS3Objects.mockResolvedValueOnce([]);

    const request = await authedRequest(fileId);
    await GET(request as never);

    expect(context.mocks.s3.listS3Objects).toHaveBeenCalledWith(
      expect.any(String),
      `uploads/${user.userId}/${fileId}/`,
    );
  });
});
