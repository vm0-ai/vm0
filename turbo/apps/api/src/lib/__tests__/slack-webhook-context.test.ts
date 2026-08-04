import { WebClient } from "@slack/web-api";
import { describe, expect, it } from "vitest";

import {
  enrichMessageContent,
  normalizeSlackMessageContent,
} from "../slack-webhook-context";

describe("Slack message normalization", () => {
  it("extracts direct user mentions from fallback text only", () => {
    expect(
      normalizeSlackMessageContent({
        text: "hello <@U_OWNER> <!channel> <!subteam^S_GROUP>",
      }),
    ).toStrictEqual({
      text: "hello <@U_OWNER> <!channel> <!subteam^S_GROUP>",
      directlyMentionedUserIds: ["U_OWNER"],
    });
  });

  it("extracts W-prefixed Enterprise users from fallback text", () => {
    expect(
      normalizeSlackMessageContent({
        text: "hello <@W123ABC> <!channel> <!subteam^S_GROUP>",
      }),
    ).toStrictEqual({
      text: "hello <@W123ABC> <!channel> <!subteam^S_GROUP>",
      directlyMentionedUserIds: ["W123ABC"],
    });
  });

  it("recurses through rich text and excludes broadcasts and user groups", () => {
    expect(
      normalizeSlackMessageContent({
        text: "fallback <@U_FALLBACK> <@U_OWNER>",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_list",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [
                      { type: "text", text: "rich " },
                      { type: "user", user_id: "U_OWNER" },
                      { type: "broadcast", range: "channel" },
                      { type: "usergroup", usergroup_id: "S_GROUP" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toStrictEqual({
      text: "- rich <@U_OWNER>@channel<!subteam^S_GROUP>",
      directlyMentionedUserIds: ["U_OWNER", "U_FALLBACK"],
    });
  });

  it("preloads and resolves W-prefixed mentions for Slack Chat content", async () => {
    const requestedUserIds: string[][] = [];
    const result = await enrichMessageContent({
      messageContent: "hello <@W123ABC>",
      files: undefined,
      client: new WebClient("xoxb-test"),
      userId: "U_SENDER",
      userInfoResolver: {
        resolveMany(userIds) {
          requestedUserIds.push([...userIds]);
          return Promise.resolve(
            new Map([
              ["U_SENDER", { id: "U_SENDER", name: "Sender" }],
              ["W123ABC", { id: "W123ABC", name: "Enterprise User" }],
            ]),
          );
        },
        stats() {
          return {
            requestedCount: 0,
            cacheHitCount: 0,
            missCount: 0,
            inFlightHitCount: 0,
          };
        },
      },
    });

    expect(requestedUserIds).toStrictEqual([["U_SENDER", "W123ABC"]]);
    expect(result.prompt).toBe("hello @Enterprise User (W123ABC)");
    expect(result.displayContent).toBe("hello @Enterprise User");
    expect(result.mentionDisplayNames).toStrictEqual({
      W123ABC: "Enterprise User",
    });
  });
});
