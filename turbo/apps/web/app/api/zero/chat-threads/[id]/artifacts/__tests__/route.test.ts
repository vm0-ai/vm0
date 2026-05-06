import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { GET, POST as SYNC_POST } from "../route";
import { POST } from "../../../route";
import {
  createTestCompose,
  createTestRequest,
  insertTestChatMessage,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { seedTestRun } from "../../../../../../../src/__tests__/db-test-seeders/runs";
import { insertTestConnectorSecret } from "../../../../../../../src/__tests__/db-test-seeders/connectors";
import { recordRunUploadedFile } from "../../../../../../../src/lib/zero/uploads/run-uploaded-files";
import { server } from "../../../../../../../src/mocks/server";

const context = testContext();

describe("GET /api/zero/chat-threads/:threadId/artifacts", () => {
  let testComposeId: string;
  let testUserId: string;
  let testOrgId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    testUserId = user.userId;
    testOrgId = user.orgId;

    const { composeId } = await createTestCompose(uniqueId("artifacts"));
    testComposeId = composeId;
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/chat-threads/thread-id/artifacts",
      ),
    );

    expect(response.status).toBe(401);
  });

  it("returns run uploaded files grouped by run", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();
    const { runId } = await seedTestRun(testUserId, testComposeId, {
      status: "completed",
      prompt: "Use the attached file",
      chatThreadId: threadId,
    });

    await recordRunUploadedFile({
      runId,
      source: "web",
      externalId: "file-1",
      userId: testUserId,
      orgId: testOrgId,
      filename: "data.csv",
      contentType: "text/csv",
      sizeBytes: 2048,
      url: `http://localhost:3000/f/${testUserId}/file-1/data.csv`,
    });

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/artifacts`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].runId).toBe(runId);
    expect(data.runs[0].files[0]).toMatchObject({
      id: "file-1",
      filename: "data.csv",
      contentType: "text/csv",
      size: 2048,
    });
    expect(data.runs[0].files[0].url).toContain("/f/");
  });

  it("returns Google Drive sync status from the connected Drive account", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();
    const { runId } = await seedTestRun(testUserId, testComposeId, {
      status: "completed",
      prompt: "Use the attached file",
      chatThreadId: threadId,
    });

    await context.createConnector(testOrgId, {
      userId: testUserId,
      type: "google-drive",
      authMethod: "oauth",
    });
    await insertTestConnectorSecret(
      testOrgId,
      testUserId,
      "GOOGLE_DRIVE_ACCESS_TOKEN",
      "drive-access-token",
    );
    await recordRunUploadedFile({
      runId,
      source: "web",
      externalId: "file-1",
      userId: testUserId,
      orgId: testOrgId,
      filename: "data.csv",
      contentType: "text/csv",
      sizeBytes: 2048,
      url: `http://localhost:3000/f/${testUserId}/file-1/data.csv`,
    });

    let authHeader: string | null = null;
    let driveQuery = "";
    server.use(
      http.get("https://www.googleapis.com/drive/v3/files", ({ request }) => {
        const url = new URL(request.url);
        authHeader = request.headers.get("authorization");
        driveQuery = url.searchParams.get("q") ?? "";
        return HttpResponse.json({
          files: [
            {
              id: "drive-file-id",
              name: "data.csv",
              webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
              appProperties: {
                vm0Artifact: "true",
                vm0ThreadId: threadId,
                vm0RunId: runId,
                vm0FileId: "file-1",
              },
            },
          ],
        });
      }),
    );

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/artifacts`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(authHeader).toBe("Bearer drive-access-token");
    expect(driveQuery).toContain("appProperties has");
    expect(driveQuery).toContain(`value='${threadId}'`);
    expect(data.runs[0].files[0].googleDriveSync).toStrictEqual({
      status: "synced",
      id: "drive-file-id",
      name: "data.csv",
      webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
    });
  });

  it("uses chat message run ownership when zero run chat thread is missing", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();
    const { runId } = await seedTestRun(testUserId, testComposeId, {
      status: "completed",
      prompt: "Uploaded during the run",
    });

    await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "user",
      content: "Uploaded during the run",
      runId,
    });
    await recordRunUploadedFile({
      runId,
      source: "web",
      externalId: "file-fallback",
      userId: testUserId,
      orgId: testOrgId,
      filename: "preview.html",
      contentType: "text/html",
      sizeBytes: 512,
      url: `http://localhost:3000/f/${testUserId}/file-fallback/preview.html`,
    });

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/artifacts`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].runId).toBe(runId);
    expect(data.runs[0].files[0]).toMatchObject({
      id: "file-fallback",
      filename: "preview.html",
      contentType: "text/html",
      size: 512,
    });
  });

  it("syncs a thread artifact file to Google Drive", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();
    const { runId } = await seedTestRun(testUserId, testComposeId, {
      status: "completed",
      prompt: "Use the attached file",
      chatThreadId: threadId,
    });
    const s3Key = `uploads/${testUserId}/file-1/data.csv`;

    await context.createConnector(testOrgId, {
      userId: testUserId,
      type: "google-drive",
      authMethod: "oauth",
    });
    await insertTestConnectorSecret(
      testOrgId,
      testUserId,
      "GOOGLE_DRIVE_ACCESS_TOKEN",
      "drive-access-token",
    );
    await recordRunUploadedFile({
      runId,
      source: "web",
      externalId: "file-1",
      userId: testUserId,
      orgId: testOrgId,
      filename: "data.csv",
      contentType: "text/csv",
      sizeBytes: 2048,
      url: `http://localhost:3000/f/${testUserId}/file-1/data.csv`,
      metadata: { s3Key },
    });

    context.mocks.s3.downloadS3Buffer.mockResolvedValueOnce(
      Buffer.from("name,value\nalpha,1\n"),
    );

    let authHeader: string | null = null;
    let contentType: string | null = null;
    let uploadType: string | null = null;
    let uploadBody = "";
    const folderQueries: string[] = [];
    const createdFolders: unknown[] = [];
    server.use(
      http.get("https://www.googleapis.com/drive/v3/files", ({ request }) => {
        const url = new URL(request.url);
        folderQueries.push(url.searchParams.get("q") ?? "");
        return HttpResponse.json({ files: [] });
      }),
      http.post(
        "https://www.googleapis.com/drive/v3/files",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          createdFolders.push(body);
          return HttpResponse.json({
            id:
              createdFolders.length === 1
                ? "drive-folder-vm0-artifact"
                : "drive-folder-chat-thread",
            name: typeof body.name === "string" ? body.name : "folder",
          });
        },
      ),
      http.post(
        "https://www.googleapis.com/upload/drive/v3/files",
        async ({ request }) => {
          const url = new URL(request.url);
          authHeader = request.headers.get("authorization");
          contentType = request.headers.get("content-type");
          uploadType = url.searchParams.get("uploadType");
          uploadBody = await request.text();
          return HttpResponse.json({
            id: "drive-file-id",
            name: "data.csv",
            webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
          });
        },
      ),
    );

    const response = await SYNC_POST(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/artifacts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId, fileId: "file-1" }),
        },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      id: "drive-file-id",
      name: "data.csv",
      webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
    });
    expect(context.mocks.s3.downloadS3Buffer).toHaveBeenCalledWith(
      expect.any(String),
      s3Key,
    );
    expect(authHeader).toBe("Bearer drive-access-token");
    expect(contentType).toContain("multipart/related");
    expect(uploadType).toBe("multipart");
    expect(folderQueries).toHaveLength(2);
    expect(folderQueries[0]).toContain("name = 'vm0-artifact'");
    expect(folderQueries[0]).toContain("'root' in parents");
    expect(folderQueries[1]).toContain(`name = 'chat-${threadId}'`);
    expect(folderQueries[1]).toContain(
      "'drive-folder-vm0-artifact' in parents",
    );
    expect(createdFolders).toStrictEqual([
      {
        name: "vm0-artifact",
        mimeType: "application/vnd.google-apps.folder",
      },
      {
        name: `chat-${threadId}`,
        mimeType: "application/vnd.google-apps.folder",
        parents: ["drive-folder-vm0-artifact"],
      },
    ]);
    expect(uploadBody).toContain('"name":"data.csv"');
    expect(uploadBody).toContain('"parents":["drive-folder-chat-thread"]');
    expect(uploadBody).toContain('"vm0Artifact":"true"');
    expect(uploadBody).toContain(`"vm0ThreadId":"${threadId}"`);
    expect(uploadBody).toContain(`"vm0RunId":"${runId}"`);
    expect(uploadBody).toContain('"vm0FileId":"file-1"');
    expect(uploadBody).toContain("Content-Type: text/csv\r\n\r\nname,value");
  });

  it("requires a connected Google Drive account before syncing", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();

    const response = await SYNC_POST(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/artifacts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: "00000000-0000-4000-8000-000000000001",
            fileId: "file-1",
          }),
        },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toBe(
      "Connect Google Drive before syncing artifacts",
    );
  });
});
