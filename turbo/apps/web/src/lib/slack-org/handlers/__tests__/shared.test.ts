import { describe, it, expect, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import {
  buildOrgConnectUrl,
  buildLogsUrl,
  buildAgentLogsUrl,
  enrichMessageContent,
} from "../shared";

describe("buildOrgConnectUrl", () => {
  it("should point to platform slack connect page", () => {
    const url = buildOrgConnectUrl("T-workspace", "U-user", "C-channel");

    expect(url).toContain("/slack/connect");
    expect(url).toContain("w=T-workspace");
    expect(url).toContain("u=U-user");
    expect(url).toContain("c=C-channel");
  });

  it("should include threadTs when provided", () => {
    const url = buildOrgConnectUrl(
      "T-workspace",
      "U-user",
      "C-channel",
      "1234567890.123456",
    );

    expect(url).toContain("t=1234567890.123456");
  });

  it("should not include threadTs param when not provided", () => {
    const url = buildOrgConnectUrl("T-workspace", "U-user", "C-channel");

    expect(url).not.toContain("&t=");
  });

  it("should not include empty channelId", () => {
    const url = buildOrgConnectUrl("T-ws", "U-usr", "");

    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/slack/connect");
    expect(parsed.searchParams.get("w")).toBe("T-ws");
    expect(parsed.searchParams.get("u")).toBe("U-usr");
    expect(parsed.searchParams.has("c")).toBe(false);
  });
});

describe("buildLogsUrl", () => {
  it("should return platform URL with activity path", () => {
    const url = buildLogsUrl("run-123");

    expect(url).toBe("http://localhost:3001/activity/run-123");
  });

  it("should encode run ID in URL", () => {
    const url = buildLogsUrl("run/with/slashes");

    expect(url).toBe("http://localhost:3001/activity/run%2Fwith%2Fslashes");
  });
});

describe("buildAgentLogsUrl", () => {
  it("should return platform URL with activity path", () => {
    const url = buildAgentLogsUrl();

    expect(url).toBe("http://localhost:3001/activity");
  });
});

function createMockSlackClient(
  usersInfoResponse: Record<string, unknown>,
): WebClient {
  return {
    users: {
      info: vi.fn().mockResolvedValue(usersInfoResponse),
    },
  } as unknown as WebClient;
}

describe("enrichMessageContent", () => {
  it("should return prompt and userContext as separate fields", async () => {
    const client = createMockSlackClient({
      ok: true,
      user: {
        id: "U123",
        profile: { display_name: "Jane", real_name: "Jane Doe" },
        tz_label: "Pacific Standard Time",
      },
    });

    const result = await enrichMessageContent({
      messageContent: "Hello world",
      files: undefined,
      botToken: "xoxb-test",
      channelId: "C123",
      threadTs: "1234567890.001",
      client,
      userId: "U123",
    });

    expect(result.prompt).toBe("Hello world");
    expect(result.userContext).toContain("# Current User");
    expect(result.userContext).toContain("[Slack User]");
    expect(result.userContext).toContain("Slack User ID: U123");
    expect(result.userContext).toContain("Name: Jane");
  });

  it("should return empty userContext when user info is unavailable", async () => {
    const client = createMockSlackClient({ ok: false, error: "not_found" });

    const result = await enrichMessageContent({
      messageContent: "Hello world",
      files: undefined,
      botToken: "xoxb-test",
      channelId: "C123",
      threadTs: "1234567890.001",
      client,
      userId: "U999",
    });

    expect(result.prompt).toBe("Hello world");
    expect(result.userContext).toBe("");
  });

  it("should not prepend user info to prompt", async () => {
    const client = createMockSlackClient({
      ok: true,
      user: {
        id: "U123",
        profile: { display_name: "Jane", real_name: "Jane Doe" },
        tz_label: "PST",
      },
    });

    const result = await enrichMessageContent({
      messageContent: "My message",
      files: undefined,
      botToken: "xoxb-test",
      channelId: "C123",
      threadTs: "1234567890.001",
      client,
      userId: "U123",
    });

    expect(result.prompt).not.toContain("[Slack User]");
    expect(result.prompt).not.toContain("Slack User ID");
    expect(result.prompt).toBe("My message");
  });
});
