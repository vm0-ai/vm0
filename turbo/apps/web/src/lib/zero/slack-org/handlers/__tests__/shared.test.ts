import { describe, it, expect, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { HttpResponse } from "msw";
import {
  buildOrgConnectUrl,
  buildLogsUrl,
  buildAgentLogsUrl,
  enrichMessageContent,
  fetchConversationContexts,
} from "../shared";
import { testContext } from "../../../../../__tests__/test-helpers";
import { server } from "../../../../../mocks/server";
import { http } from "../../../../../__tests__/msw";

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
  it("should return prompt and userInfoExtras as separate fields", async () => {
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
    expect(result.userInfoExtras).toEqual({
      slackDisplayName: "Jane",
      slackUserId: "U123",
    });
  });

  it("should return empty userInfoExtras when user info is unavailable", async () => {
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
    expect(result.userInfoExtras).toEqual({});
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
    expect(result.prompt).not.toContain("- SENDER:");
    expect(result.prompt).toBe("My message");
  });

  it("should resolve user mentions in prompt text", async () => {
    const userDb: Record<string, Record<string, unknown>> = {
      U123: {
        id: "U123",
        profile: { display_name: "Alice", real_name: "Alice A" },
      },
      U456: {
        id: "U456",
        profile: { display_name: "Bob", real_name: "Bob B" },
      },
    };
    const client = {
      users: {
        info: vi.fn().mockImplementation(({ user }: { user: string }) => {
          const u = userDb[user];
          return Promise.resolve(u ? { ok: true, user: u } : { ok: false });
        }),
      },
    } as unknown as WebClient;

    const result = await enrichMessageContent({
      messageContent: "Hey <@U456>, please review this",
      files: undefined,
      botToken: "xoxb-test",
      channelId: "C123",
      threadTs: "1234567890.001",
      client,
      userId: "U123",
    });

    expect(result.prompt).toContain("@Bob (U456)");
    expect(result.prompt).not.toContain("<@U456>");
  });
});

function createMockConversationClient(opts: {
  threadMessages?: Record<string, unknown>[];
  channelMessages?: Record<string, unknown>[];
}): WebClient {
  return {
    conversations: {
      replies: vi.fn().mockResolvedValue({
        ok: true,
        messages: opts.threadMessages ?? [],
      }),
      history: vi.fn().mockResolvedValue({
        ok: true,
        messages: opts.channelMessages ?? [],
      }),
    },
    users: {
      info: vi.fn().mockResolvedValue({ ok: false }),
    },
  } as unknown as WebClient;
}

describe("fetchConversationContexts", () => {
  it("should include channel messages for thread", async () => {
    const client = createMockConversationClient({
      threadMessages: [
        { user: "U100", text: "Thread parent", ts: "100.0" },
        { user: "U200", text: "Reply", ts: "100.1" },
      ],
      channelMessages: [
        { user: "U300", text: "Channel msg A", ts: "99.1" },
        { user: "U400", text: "Channel msg B", ts: "99.2" },
      ],
    });

    const { executionContext } = await fetchConversationContexts(
      client,
      "C-chan",
      "100.0", // threadTs
      "BBOT",
      "xoxb-token",
      "100.1", // currentMessageTs excluded from context
    );

    // Should contain both channel and thread sections
    expect(executionContext).toContain("# Recent Channel Messages");
    expect(executionContext).toContain("# Slack Thread Context");
    expect(executionContext).toContain("Channel msg A");
    expect(executionContext).toContain("Channel msg B");
    expect(executionContext).toContain("Thread parent");
    // Current message excluded
    expect(executionContext).not.toContain("Reply");
  });

  it("should fetch channel messages with latest=threadTs", async () => {
    const client = createMockConversationClient({
      threadMessages: [{ user: "U100", text: "Parent", ts: "100.0" }],
      channelMessages: [{ user: "U300", text: "Before thread", ts: "99.0" }],
    });

    await fetchConversationContexts(
      client,
      "C-chan",
      "100.0",
      "BBOT",
      "xoxb-token",
    );

    // conversations.history should be called with latest=threadTs
    const historyMock = client.conversations.history as ReturnType<
      typeof vi.fn
    >;
    expect(historyMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C-chan", latest: "100.0" }),
    );
  });

  it("should always include full thread context and channel messages", async () => {
    const client = createMockConversationClient({
      threadMessages: [
        { user: "U100", text: "Parent", ts: "100.0" },
        { user: "U200", text: "Old reply", ts: "100.1" },
        { user: "U200", text: "New reply", ts: "100.2" },
      ],
      channelMessages: [{ user: "U300", text: "Channel context", ts: "99.0" }],
    });

    const { executionContext } = await fetchConversationContexts(
      client,
      "C-chan",
      "100.0",
      "BBOT",
      "xoxb-token",
      "100.2", // currentMessageTs
    );

    // All thread messages included (no dedup filtering)
    expect(executionContext).toContain("Parent");
    expect(executionContext).toContain("Old reply");
    // Channel context always included
    expect(executionContext).toContain("# Recent Channel Messages");
    expect(executionContext).toContain("Channel context");
  });

  it("should NOT include channel messages for channel @mention", async () => {
    const client = createMockConversationClient({
      channelMessages: [
        { user: "U100", text: "Msg 1", ts: "1.0" },
        { user: "U200", text: "Msg 2", ts: "2.0" },
      ],
    });

    const { executionContext } = await fetchConversationContexts(
      client,
      "C-chan",
      undefined, // no threadTs → channel mention
      "BBOT",
      "xoxb-token",
      "2.0",
    );

    // Single channel section, no duplication
    expect(executionContext).toContain("# Recent Channel Messages");
    expect(executionContext).not.toContain("# Slack Thread Context");
    expect(executionContext).toContain("Msg 1");
    // conversations.history called once (for channel context), not twice
    expect(client.conversations.history).toHaveBeenCalledTimes(1);
  });

  it("should NOT fetch channel context for DM without thread", async () => {
    const client = createMockConversationClient({
      channelMessages: [{ user: "U100", text: "Should not appear", ts: "1.0" }],
    });

    const { executionContext } = await fetchConversationContexts(
      client,
      "D-dm-channel", // DM channel ID starts with "D"
      undefined, // no threadTs
      "BBOT",
      "xoxb-token",
    );

    expect(executionContext).toBe("");
    expect(client.conversations.history).not.toHaveBeenCalled();
  });

  it("should NOT fetch channel context for DM thread", async () => {
    const client = createMockConversationClient({
      threadMessages: [
        { user: "U100", text: "DM thread parent", ts: "100.0" },
        { user: "U200", text: "DM reply", ts: "100.1" },
      ],
      channelMessages: [
        { user: "U300", text: "Should not appear", ts: "99.0" },
      ],
    });

    const { executionContext } = await fetchConversationContexts(
      client,
      "D-dm-channel", // DM channel ID
      "100.0", // threadTs
      "BBOT",
      "xoxb-token",
      "100.1", // currentMessageTs
    );

    // Thread context should be present, but no channel context
    expect(executionContext).toContain("# Slack Thread Context");
    expect(executionContext).not.toContain("# Recent Channel Messages");
    expect(executionContext).toContain("DM thread parent");
    expect(executionContext).not.toContain("Should not appear");
    expect(client.conversations.history).not.toHaveBeenCalled();
  });

  describe("image upload in channel context prefix", () => {
    const context = testContext();

    it("should upload images in channel messages to S3 for thread", async () => {
      context.setupMocks();

      const downloadHandler = http.get(
        "https://files.slack.com/files-pri/T123-F999/download/screenshot.png",
        () => {
          return new HttpResponse(Buffer.from("fake-png-data"), {
            headers: { "content-type": "image/png" },
          });
        },
      );
      server.use(downloadHandler.handler);

      context.mocks.s3.generatePresignedUrl.mockResolvedValue(
        "https://mock-presigned-url/screenshot.png",
      );

      const client = createMockConversationClient({
        threadMessages: [{ user: "U100", text: "Thread parent", ts: "100.0" }],
        channelMessages: [
          {
            user: "U200",
            text: "Look at this",
            ts: "99.0",
            files: [
              {
                id: "F999",
                name: "screenshot.png",
                mimetype: "image/png",
                filetype: "png",
                url_private_download:
                  "https://files.slack.com/files-pri/T123-F999/download/screenshot.png",
              },
            ],
          },
        ],
      });

      const { executionContext } = await fetchConversationContexts(
        client,
        "C-chan",
        "100.0",
        "BBOT",
        "xoxb-token",
      );

      // S3 upload should have been triggered for the channel message image
      expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalled();
      expect(context.mocks.s3.generatePresignedUrl).toHaveBeenCalled();

      // executionContext should contain the presigned URL, not a raw Slack permalink
      expect(executionContext).toContain("https://mock-presigned-url");
      expect(executionContext).not.toContain("permalink_public");
      expect(executionContext).toContain("# Recent Channel Messages");
    });
  });
});
