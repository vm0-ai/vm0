import { describe, expect, it } from "vitest";

import { normalizeSlackMessageContent } from "../slack-webhook-context";

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
});
