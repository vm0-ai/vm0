import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { listCommand } from "../channel/list";

const listUrl = "http://localhost:3000/api/integrations/slack/channels";

describe("okou slack channel list", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    listCommand.setOptionValue("json", undefined);
    listCommand.setOptionValue("cursor", undefined);
    listCommand.setOptionValue("limit", "100");
  });

  it("shows unjoined public channels with their invitation destination", async () => {
    const channelUrl = "https://slack.com/app_redirect?team=T123&channel=C123";
    server.use(
      http.get(listUrl, () => {
        return HttpResponse.json({
          channels: [
            {
              id: "C123",
              name: "general",
              isPrivate: false,
              isMember: false,
              channelUrl,
            },
          ],
          nextCursor: null,
        });
      }),
    );
    await listCommand.parseAsync(["node", "okou"]);
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain("#general");
    expect(text).toContain("invite Okou first");
    expect(text).toContain(channelUrl);
    expect(text).toContain("okou slack message history");
  });

  it("preserves a cursor on an empty page in JSON output", async () => {
    let query: URLSearchParams | undefined;
    server.use(
      http.get(listUrl, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({ channels: [], nextCursor: "another-page" });
      }),
    );
    await listCommand.parseAsync([
      "node",
      "okou",
      "--cursor",
      "previous-page",
      "--limit",
      "25",
      "--json",
    ]);
    expect(Object.fromEntries(query ?? [])).toStrictEqual({
      limit: "25",
      cursor: "previous-page",
    });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      channels: [],
      nextCursor: "another-page",
    });
  });
});
