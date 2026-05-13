import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestCompose,
  createTestRequest,
  insertOrgMembersCacheEntry,
  insertTestAgentPhoneMessage,
  insertTestAgentPhoneUserLink,
} from "../../../../../../../../src/__tests__/api-test-helpers";
import { seedTestRun } from "../../../../../../../../src/__tests__/db-test-seeders/runs";
import { countTestAgentPhoneMessages } from "../../../../../../../../src/__tests__/db-test-assertions/agentphone";
import { findTestRunUploadedFiles } from "../../../../../../../../src/__tests__/db-test-assertions/run-uploaded-files";
import {
  testContext,
  uniqueId,
  uniqueNumericId,
  type UserContext,
} from "../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../../../../src/lib/auth/sandbox-token";
import { server } from "../../../../../../../../src/mocks/server";

const URL =
  "http://localhost:3000/api/zero/integrations/phone/upload-file/complete";
const AGENTPHONE_AGENT_ID = "agt-phone-upload-route";

const context = testContext();

function uniquePhone(): string {
  return `+1555${uniqueNumericId().slice(0, 7)}`;
}

describe("POST /api/zero/integrations/phone/upload-file/complete", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  async function zeroTokenWithRun(): Promise<{
    token: string;
    runId: string;
  }> {
    const { composeId } = await createTestCompose(uniqueId("agentphone"));
    const { runId } = await seedTestRun(user.userId, composeId, {
      triggerSource: "agentphone",
    });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    mockClerk({ userId: null });
    const token = await generateZeroToken(user.userId, runId, user.orgId);
    return { token, runId };
  }

  function completeRequest(body: unknown, token?: string): NextRequest {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    return createTestRequest(URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("sends the uploaded file URL through the inferred AgentPhone agent", async () => {
    const { token, runId } = await zeroTokenWithRun();
    const phone = uniquePhone();
    const link = await insertTestAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    await insertTestAgentPhoneMessage({
      agentphoneMessageId: uniqueId("apmsg-inbound"),
      agentphoneAgentId: AGENTPHONE_AGENT_ID,
      agentphoneUserLinkId: link.id,
      phoneHandle: phone,
      fromNumber: phone,
      toNumber: "+19039853128",
      direction: "inbound",
      body: "please review this file",
    });

    const uploadId = randomUUID();
    const s3Key = `uploads/${user.userId}/${uploadId}/report.pdf`;
    const fileUrl = `http://localhost:3000/f/${encodeURIComponent(
      user.userId.replace(/^user_/, ""),
    )}/${uploadId}/report.pdf`;
    const sentMessageId = uniqueId("apmsg-file-outbound");

    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: s3Key, size: 1234 },
    ]);

    let agentPhoneBody: Record<string, unknown> | undefined;
    server.use(
      http.post(
        "https://api.agentphone.to/v1/messages",
        async ({ request }) => {
          agentPhoneBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            id: sentMessageId,
            status: "sent",
            channel: "sms",
            from_number: "+19039853128",
            to_number: phone,
          });
        },
      ),
    );

    const response = await POST(
      completeRequest(
        {
          uploadId,
          toNumber: phone,
          contentType: "application/pdf",
          caption: "Daily report",
        },
        token,
      ),
    );

    expect(response.status).toBe(200);
    expect(agentPhoneBody).toMatchObject({
      agent_id: AGENTPHONE_AGENT_ID,
      to_number: phone,
      body: "Daily report",
      media_url: fileUrl,
    });
    expect(await response.json()).toMatchObject({
      messageId: sentMessageId,
      channel: "sms",
      toNumber: phone,
      filename: "report.pdf",
      mimetype: "application/pdf",
      size: 1234,
      url: fileUrl,
    });

    const rows = await findTestRunUploadedFiles("agentphone", sentMessageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId,
      source: "agentphone",
      externalId: sentMessageId,
      userId: user.userId,
      orgId: user.orgId,
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      url: fileUrl,
      metadata: {
        toNumber: phone,
        uploadId,
        sourceUrl: fileUrl,
        caption: "Daily report",
        agentphoneMessage: {
          id: sentMessageId,
        },
      },
    });
    expect(await countTestAgentPhoneMessages(phone)).toBe(2);
  });

  it("returns 404 when no uploaded object exists for the user upload id", async () => {
    const { token } = await zeroTokenWithRun();

    const response = await POST(
      completeRequest(
        {
          uploadId: randomUUID(),
          toNumber: uniquePhone(),
          caption: "missing upload",
        },
        token,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
