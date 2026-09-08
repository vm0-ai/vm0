import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { historyCommand } from "../message/history";

const historyUrl = "http://localhost:3000/api/integrations/slack/history";
const channelUrl = "https://slack.com/app_redirect?team=T123&channel=C123";

describe("okou slack message history", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    for (const option of ["channel", "cursor", "oldest", "latest", "json"]) {
      historyCommand.setOptionValue(option, undefined);
    }
    historyCommand.setOptionValue("limit", "15");
  });

  it("reads a bot DM with time filters and preserves message metadata in JSON", async () => {
    const message = {
      type: "message",
      ts: "1750000001.000001",
      text: "hello",
      user: "U123",
      files: [{ id: "F123", name: "report.pdf" }],
    };
    let query: URLSearchParams | undefined;
    server.use(
      http.get(historyUrl, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({
          channel: "D123",
          channelUrl,
          messages: [message],
          hasMore: true,
          nextCursor: "next+page=",
        });
      }),
    );
    await historyCommand.parseAsync([
      "node",
      "okou",
      "--channel",
      "D123",
      "--oldest",
      "1750000000.000001",
      "--latest",
      "1750100000.000001",
      "--cursor",
      "previous+page=",
      "--json",
    ]);
    expect(Object.fromEntries(query ?? [])).toStrictEqual({
      channel: "D123",
      limit: "15",
      oldest: "1750000000.000001",
      latest: "1750100000.000001",
      cursor: "previous+page=",
    });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      messages: [message],
      nextCursor: "next+page=",
    });
  });

  it("prints messages and a continuation cursor", async () => {
    server.use(
      http.get(historyUrl, () => {
        return HttpResponse.json({
          channel: "C123",
          channelUrl,
          messages: [
            {
              type: "message",
              ts: "1750000001.000001",
              user: "U123",
              text: "Release is ready",
              reply_count: 2,
            },
          ],
          hasMore: true,
          nextCursor: "next-page",
        });
      }),
    );
    await historyCommand.parseAsync(["node", "okou", "--channel", "C123"]);
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain("Release is ready");
    expect(text).toContain("2 replies; not expanded");
    expect(text).toContain("next-page");
  });

  it("preserves the invitation link on a membership failure and exits unsuccessfully", async () => {
    server.use(
      http.get(historyUrl, () => {
        return HttpResponse.json(
          {
            error: {
              code: "BOT_NOT_IN_CHANNEL",
              message: `Add Okou via Agents & apps, then retry. ${channelUrl}`,
              channelUrl,
            },
          },
          { status: 403 },
        );
      }),
    );
    await expect(
      historyCommand.parseAsync(["node", "okou", "--channel", "C123"]),
    ).rejects.toThrow("process.exit");
    expect(errors.mock.calls.flat().join("\n")).toContain(channelUrl);
    expect(output).not.toHaveBeenCalled();
  });

  it("rejects reversed time ranges before calling the API", async () => {
    await expect(
      historyCommand.parseAsync([
        "node",
        "okou",
        "--channel",
        "C123",
        "--oldest",
        "20",
        "--latest",
        "10",
      ]),
    ).rejects.toThrow("process.exit");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "oldest must be earlier than latest",
    );
  });

  it("returns Slack's retry duration without retrying immediately", async () => {
    server.use(
      http.get(historyUrl, () => {
        return HttpResponse.json(
          {
            error: {
              code: "SLACK_RATE_LIMITED",
              message: "Slack rate limit reached. Retry after 60 seconds.",
              retryAfterSeconds: 60,
            },
          },
          { status: 429, headers: { "Retry-After": "60" } },
        );
      }),
    );
    await expect(
      historyCommand.parseAsync(["node", "okou", "--channel", "D123"]),
    ).rejects.toThrow("process.exit");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Retry after 60 seconds",
    );
  });
});
