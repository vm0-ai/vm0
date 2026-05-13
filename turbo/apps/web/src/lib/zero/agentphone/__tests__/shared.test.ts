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
    const agentphoneMessageId = uniqueId("apmsg-media");
    const userLink = await insertTestAgentPhoneUserLink({
      phoneHandle,
      vm0UserId: uniqueId("user"),
      orgId: uniqueId("org"),
    });
    await insertTestAgentPhoneMessage({
      agentphoneMessageId,
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
    expect(contextResult.executionContext).toContain(
      `[ID] ${agentphoneMessageId}`,
    );
    expect(contextResult.executionContext).not.toContain(
      "https://cdn.agentphone.test/files/photo.jpg",
    );
  });

  it("includes resumed conversation context regardless of lastProcessedMessageId", async () => {
    const phoneHandle = uniquePhone();
    const userLink = await insertTestAgentPhoneUserLink({
      phoneHandle,
      vm0UserId: uniqueId("user"),
      orgId: uniqueId("org"),
    });

    await insertTestAgentPhoneMessage({
      agentphoneMessageId: "apmsg-old",
      agentphoneUserLinkId: userLink.id,
      phoneHandle,
      fromNumber: phoneHandle,
      toNumber: "+19039853128",
      direction: "inbound",
      body: "Old AgentPhone message",
      createdAt: new Date(Date.now() - 60_000),
    });
    await insertTestAgentPhoneMessage({
      agentphoneMessageId: "apmsg-new",
      agentphoneUserLinkId: userLink.id,
      phoneHandle,
      fromNumber: phoneHandle,
      toNumber: "+19039853128",
      direction: "inbound",
      body: "New AgentPhone message",
      createdAt: new Date(Date.now() - 30_000),
    });

    const contextResult = await fetchAgentPhoneContext({
      userLinkId: userLink.id,
      phoneHandle,
      lastProcessedMessageId: "apmsg-old",
    });

    expect(contextResult.executionContext).toContain("Old AgentPhone message");
    expect(contextResult.executionContext).toContain("New AgentPhone message");
  });

  it("excludes current message while keeping resumed conversation history", async () => {
    const phoneHandle = uniquePhone();
    const userLink = await insertTestAgentPhoneUserLink({
      phoneHandle,
      vm0UserId: uniqueId("user"),
      orgId: uniqueId("org"),
    });

    await insertTestAgentPhoneMessage({
      agentphoneMessageId: "apmsg-history",
      agentphoneUserLinkId: userLink.id,
      phoneHandle,
      fromNumber: phoneHandle,
      toNumber: "+19039853128",
      direction: "inbound",
      body: "Earlier AgentPhone context",
      createdAt: new Date(Date.now() - 60_000),
    });
    await insertTestAgentPhoneMessage({
      agentphoneMessageId: "apmsg-current",
      agentphoneUserLinkId: userLink.id,
      phoneHandle,
      fromNumber: phoneHandle,
      toNumber: "+19039853128",
      direction: "inbound",
      body: "Current AgentPhone prompt",
      createdAt: new Date(Date.now() - 30_000),
    });

    const contextResult = await fetchAgentPhoneContext({
      userLinkId: userLink.id,
      phoneHandle,
      lastProcessedMessageId: "apmsg-history",
      currentMessageId: "apmsg-current",
    });

    expect(contextResult.executionContext).toContain(
      "Earlier AgentPhone context",
    );
    expect(contextResult.executionContext).not.toContain(
      "Current AgentPhone prompt",
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
