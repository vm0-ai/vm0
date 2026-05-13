import { describe, it, expect, beforeEach } from "vitest";
import {
  testContext,
  uniqueId,
  uniqueNumericId,
} from "../../../../__tests__/test-helpers";
import {
  insertTestAgentPhoneMessage,
  insertTestAgentPhoneUserLink,
} from "../../../../__tests__/api-test-helpers";
import { fetchAgentPhoneContext, enrichAgentPhonePrompt } from "../shared";

const context = testContext();

function uniquePhone(): string {
  return `+1555${uniqueNumericId().slice(0, 7)}`;
}

describe("AgentPhone file context", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("renders media as downloadable AgentPhone file blocks", async () => {
    const phoneHandle = uniquePhone();
    const userLink = await insertTestAgentPhoneUserLink({
      phoneHandle,
      vm0UserId: uniqueId("user"),
      orgId: uniqueId("org"),
    });
    await insertTestAgentPhoneMessage({
      agentphoneMessageId: "apmsg-media-1",
      agentphoneUserLinkId: userLink.id,
      phoneHandle,
      fromNumber: phoneHandle,
      toNumber: "+19039853128",
      direction: "inbound",
      body: "see attached",
      mediaUrl: "https://cdn.agentphone.test/files/photo.jpg",
    });

    const contextResult = await fetchAgentPhoneContext({
      userLinkId: userLink.id,
      phoneHandle,
    });

    expect(contextResult.executionContext).toContain(
      "[AgentPhone file] photo.jpg (image/jpeg)",
    );
    expect(contextResult.executionContext).toContain("[ID] apmsg-media-1");
    expect(contextResult.executionContext).not.toContain(
      "https://cdn.agentphone.test/files/photo.jpg",
    );
  });

  it("enriches the current prompt with a file reference", () => {
    const result = enrichAgentPhonePrompt(
      "please inspect this",
      "+15551234567",
      "apmsg-current",
      "https://cdn.agentphone.test/files/report.pdf",
    );

    expect(result.prompt).toContain("please inspect this");
    expect(result.prompt).toContain(
      "[AgentPhone file] report.pdf (application/pdf)",
    );
    expect(result.prompt).toContain("[ID] apmsg-current");
  });
});
