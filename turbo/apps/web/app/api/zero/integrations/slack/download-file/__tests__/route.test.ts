import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { WebClient } from "@slack/web-api";
import { GET } from "../route";
import {
  createTestRequest,
  insertOrgMembersCacheEntry,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { createTestSlackOrgInstallation } from "../../../../../../../src/__tests__/db-test-seeders/slack";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../../../src/lib/auth/sandbox-token";
import { server } from "../../../../../../../src/mocks/server";

const URL = "http://localhost:3000/api/zero/integrations/slack/download-file";

const context = testContext();

describe("GET /api/zero/integrations/slack/download-file", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  async function authedRequest(fileId: string): Promise<Request> {
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);
    return createTestRequest(`${URL}?file_id=${fileId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("returns 401 when no auth token provided", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(`${URL}?file_id=F1`, { method: "GET" });
    const response = await GET(request as never);

    expect(response.status).toBe(401);
  });

  it("returns 400 when file_id query param is missing", async () => {
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    await createTestSlackOrgInstallation({ orgId: user.orgId });
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);

    const request = createTestRequest(URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const response = await GET(request as never);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 when no Slack installation exists for org", async () => {
    const request = await authedRequest("F1");
    const response = await GET(request as never);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when Slack reports file not found", async () => {
    await createTestSlackOrgInstallation({ orgId: user.orgId });
    const mockClient = vi.mocked(new WebClient(""));
    vi.mocked(mockClient.files.info).mockResolvedValueOnce({
      ok: false,
      error: "file_not_found",
    } as never);

    const request = await authedRequest("F-MISSING");
    const response = await GET(request as never);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for disallowed download hostnames (SSRF guard)", async () => {
    await createTestSlackOrgInstallation({ orgId: user.orgId });
    const mockClient = vi.mocked(new WebClient(""));
    vi.mocked(mockClient.files.info).mockResolvedValueOnce({
      ok: true,
      file: {
        id: "F-BAD",
        name: "x.png",
        mimetype: "image/png",
        size: 10,
        url_private_download: "https://evil.example.com/steal.png",
      },
    } as never);

    const request = await authedRequest("F-BAD");
    const response = await GET(request as never);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("BAD_REQUEST");
    expect(data.error.message).toContain("Invalid Slack download URL");
  });

  it("returns 413 when file exceeds the 100MB limit", async () => {
    await createTestSlackOrgInstallation({ orgId: user.orgId });
    const mockClient = vi.mocked(new WebClient(""));
    vi.mocked(mockClient.files.info).mockResolvedValueOnce({
      ok: true,
      file: {
        id: "F-BIG",
        name: "huge.bin",
        mimetype: "application/octet-stream",
        size: 200 * 1024 * 1024,
        url_private_download:
          "https://files.slack.com/files-pri/T1-F-BIG/huge.bin",
      },
    } as never);

    const request = await authedRequest("F-BIG");
    const response = await GET(request as never);

    expect(response.status).toBe(413);
    const data = await response.json();
    expect(data.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("streams file bytes from Slack with content-type header", async () => {
    await createTestSlackOrgInstallation({ orgId: user.orgId });

    const fileBytes = Buffer.from("real file contents");
    const slackDownloadUrl =
      "https://files.slack.com/files-pri/T1-F-OK/download/pic.png";

    const mockClient = vi.mocked(new WebClient(""));
    vi.mocked(mockClient.files.info).mockResolvedValueOnce({
      ok: true,
      file: {
        id: "F-OK",
        name: "pic.png",
        mimetype: "image/png",
        size: fileBytes.length,
        url_private_download: slackDownloadUrl,
      },
    } as never);

    server.use(
      http.get(slackDownloadUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toContain("Bearer ");
        return new HttpResponse(fileBytes, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(fileBytes.length),
          },
        });
      }),
    );

    const request = await authedRequest("F-OK");
    const response = await GET(request as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-file-mimetype")).toBe("image/png");
    expect(response.headers.get("x-file-name")).toBe("pic.png");

    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBe(true);
  });

  it("rejects HTML responses from Slack (expired bot token)", async () => {
    await createTestSlackOrgInstallation({ orgId: user.orgId });

    const slackDownloadUrl =
      "https://files.slack.com/files-pri/T1-F-EXPIRED/download/login";

    const mockClient = vi.mocked(new WebClient(""));
    vi.mocked(mockClient.files.info).mockResolvedValueOnce({
      ok: true,
      file: {
        id: "F-EXPIRED",
        name: "something.png",
        mimetype: "image/png",
        size: 100,
        url_private_download: slackDownloadUrl,
      },
    } as never);

    server.use(
      http.get(slackDownloadUrl, () => {
        return new HttpResponse("<html><body>Login</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }),
    );

    const request = await authedRequest("F-EXPIRED");
    const response = await GET(request as never);

    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data.error.code).toBe("BAD_GATEWAY");
  });

  it("returns 400 when Slack throws a platform error from files.info", async () => {
    await createTestSlackOrgInstallation({ orgId: user.orgId });

    const slackError = new Error("An API error occurred: invalid_auth");
    Object.assign(slackError, { data: { error: "invalid_auth" } });

    const mockClient = vi.mocked(new WebClient(""));
    vi.mocked(mockClient.files.info).mockRejectedValueOnce(slackError);

    const request = await authedRequest("F-SLACK-ERR");
    const response = await GET(request as never);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("SLACK_ERROR");
    expect(data.error.message).toContain("invalid_auth");
  });
});
