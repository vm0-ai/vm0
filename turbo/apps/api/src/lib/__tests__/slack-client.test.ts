import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFileInfo, listConversations } from "../slack-client";

const TOKEN = "xoxb-test-token";

describe("listConversations", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockSlackResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("returns channels the bot is a member of, sorted by name", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockSlackResponse({
        ok: true,
        channels: [
          { id: "C2", name: "general", is_member: true },
          { id: "C1", name: "announcements", is_member: true },
          { id: "C3", name: "archived", is_member: false },
        ],
      }),
    );

    const channels = await listConversations(TOKEN);

    expect(channels).toEqual([
      { id: "C1", name: "announcements" },
      { id: "C2", name: "general" },
    ]);
  });

  it("paginates through multiple pages", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        mockSlackResponse({
          ok: true,
          channels: [
            { id: "C1", name: "alpha", is_member: true },
          ],
          response_metadata: { next_cursor: "cursor-2" },
        }),
      )
      .mockResolvedValueOnce(
        mockSlackResponse({
          ok: true,
          channels: [
            { id: "C2", name: "beta", is_member: true },
          ],
        }),
      );

    const channels = await listConversations(TOKEN);

    expect(channels).toEqual([
      { id: "C1", name: "alpha" },
      { id: "C2", name: "beta" },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("calls the Slack API with correct parameters", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockSlackResponse({ ok: true, channels: [] }),
    );

    await listConversations(TOKEN);

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls).toHaveLength(1);

    const url = new URL(calls[0]![0] as string);
    expect(url.pathname).toBe("/api/conversations.list");
    expect(url.searchParams.get("types")).toBe("public_channel,private_channel");
    expect(url.searchParams.get("exclude_archived")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("200");
  });

  it("accepts custom options", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockSlackResponse({ ok: true, channels: [] }),
    );

    await listConversations(TOKEN, {
      types: "public_channel",
      excludeArchived: false,
      limit: 50,
    });

    const url = new URL(vi.mocked(globalThis.fetch).mock.calls[0]![0] as string);
    expect(url.searchParams.get("types")).toBe("public_channel");
    expect(url.searchParams.get("exclude_archived")).toBe("false");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("throws on non-ok HTTP response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("Service Unavailable", { status: 503 }),
    );

    await expect(listConversations(TOKEN)).rejects.toThrow("Slack API error: 503");
  });

  it("throws on Slack API error response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockSlackResponse({ ok: false, error: "not_authed" }),
    );

    await expect(listConversations(TOKEN)).rejects.toThrow(
      "Slack API error: not_authed",
    );
  });

  it("handles missing channels array gracefully", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      // Some Slack responses omit channels when empty
      mockSlackResponse({ ok: true }),
    );

    const channels = await listConversations(TOKEN);
    expect(channels).toEqual([]);
  });

  it("sends the token as Bearer authorization", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockSlackResponse({ ok: true, channels: [] }),
    );

    await listConversations(TOKEN);

    const headers = vi.mocked(globalThis.fetch).mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-test-token");
  });
});

describe("getFileInfo", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockSlackResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("returns file metadata from files.info", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockSlackResponse({
        ok: true,
        file: {
          id: "F123",
          name: "report.pdf",
          mimetype: "application/pdf",
          size: 2048,
          url_private_download: "https://files.slack.com/F123/download",
        },
      }),
    );

    const file = await getFileInfo(TOKEN, "F123");

    expect(file).toEqual({
      id: "F123",
      name: "report.pdf",
      mimetype: "application/pdf",
      size: 2048,
      url_private_download: "https://files.slack.com/F123/download",
    });
  });

  it("calls files.info with the correct file ID", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockSlackResponse({
        ok: true,
        file: { id: "F456", name: "img.png", mimetype: "image/png", size: 512 },
      }),
    );

    await getFileInfo(TOKEN, "F456");

    const url = new URL(vi.mocked(globalThis.fetch).mock.calls[0]![0] as string);
    expect(url.pathname).toBe("/api/files.info");
    expect(url.searchParams.get("file")).toBe("F456");
  });

  it("throws on Slack API error", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockSlackResponse({ ok: false, error: "file_not_found" }),
    );

    await expect(getFileInfo(TOKEN, "F999")).rejects.toThrow(
      "Slack API error: file_not_found",
    );
  });
});
