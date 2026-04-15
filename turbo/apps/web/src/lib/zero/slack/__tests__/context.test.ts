import { describe, it, expect } from "vitest";
import {
  formatContextForAgent,
  formatCurrentMessageFiles,
  extractMessageContent,
  extractTextFromBlocks,
  extractMentionedUserIds,
} from "../context";

describe("Feature: Extract Message Content", () => {
  describe("Scenario: Remove bot mention from message", () => {
    it("should remove bot mention from beginning of message", () => {
      const botUserId = "U12345678";
      const text = "<@U12345678> help me with this code";

      const result = extractMessageContent(text, botUserId);

      expect(result).toBe("help me with this code");
    });

    it("should handle message with only mention", () => {
      const botUserId = "U12345678";
      const text = "<@U12345678>";

      const result = extractMessageContent(text, botUserId);

      expect(result).toBe("");
    });

    it("should handle message without mention", () => {
      const botUserId = "U12345678";
      const text = "just a regular message";

      const result = extractMessageContent(text, botUserId);

      expect(result).toBe("just a regular message");
    });

    it("should trim whitespace", () => {
      const botUserId = "U12345678";
      const text = "<@U12345678>    hello    ";

      const result = extractMessageContent(text, botUserId);

      expect(result).toBe("hello");
    });
  });
});

describe("Feature: Format Context For Agent", () => {
  describe("Scenario: Render files as download-file instructions", () => {
    it("should render uploaded images with Step 1 / Step 2 download + read instructions", () => {
      const messages = [
        {
          user: "U123",
          text: "Check this screenshot",
          ts: "1234567890.001",
          files: [
            {
              id: "F123",
              name: "screenshot.png",
              mimetype: "image/png",
              filetype: "png",
              original_w: "1920",
              original_h: "1080",
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages, "thread");

      expect(result).toContain("[file]: screenshot.png (image/png)");
      expect(result).toContain("Dimensions: 1920x1080");
      expect(result).toContain(
        "Step 1 - Download: zero slack download-file F123 -o /tmp/F123.png",
      );
      expect(result).toContain(
        "Step 2 - Read: open /tmp/F123.png with the appropriate tool",
      );
      expect(result).not.toContain("curl");
    });

    it("should render videos with Step 1 download, Step 2 ffmpeg frames, Step 3 read", () => {
      const messages = [
        {
          user: "U123",
          text: "video here",
          ts: "1",
          files: [
            {
              id: "FVID",
              name: "demo.mp4",
              mimetype: "video/mp4",
              filetype: "mp4",
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain(
        "Step 1 - Download: zero slack download-file FVID -o /tmp/FVID.mp4",
      );
      expect(result).toContain(
        'Step 2 - Extract frames: ffmpeg -i /tmp/FVID.mp4 -vf "fps=1" -q:v 2 /tmp/FVID_frame_%03d.jpg',
      );
      expect(result).toContain("Step 3 - Read: view the extracted frames");
    });

    it("should fall back to URL reference when file has no id", () => {
      const messages = [
        {
          user: "U123",
          text: "no id here",
          ts: "1",
          files: [
            {
              name: "mystery.bin",
              permalink_public: "https://example.com/mystery.bin",
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("[file]: mystery.bin");
      expect(result).toContain("URL: https://example.com/mystery.bin");
      expect(result).not.toContain("download-file");
    });

    it("should default to .bin extension when filetype is missing", () => {
      const messages = [
        {
          files: [{ id: "F_NO_TYPE", name: "thing" }],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain(
        "Step 1 - Download: zero slack download-file F_NO_TYPE -o /tmp/F_NO_TYPE.bin",
      );
    });
  });

  describe("Scenario: URL unfurls render as curl instructions (unchanged)", () => {
    it("should keep attachment unfurl using curl", () => {
      const messages = [
        {
          user: "U123",
          text: "look at this link",
          ts: "1",
          attachments: [
            {
              image_url: "https://example.com/preview.png",
              image_width: 400,
              image_height: 300,
              title: "preview",
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("[image]: preview");
      expect(result).toContain("Dimensions: 400x300");
      expect(result).toContain(
        'curl -sS -o /tmp/attachment_image.jpg "https://example.com/preview.png"',
      );
    });
  });

  describe("Scenario: Message formatting", () => {
    it("should produce thread header and preamble with file-access guidance", () => {
      const messages = [{ user: "U1", text: "hi", ts: "1" }];

      const result = formatContextForAgent(messages, "thread");

      expect(result).toContain("# Slack Thread Context");
      expect(result).toContain(
        "follow the numbered Step instructions to download and read the file",
      );
    });

    it("should produce channel header when contextType is channel", () => {
      const messages = [{ user: "U1", text: "hi", ts: "1" }];

      const result = formatContextForAgent(messages, "channel");

      expect(result).toContain("# Recent Channel Messages");
    });

    it("should include RELATIVE_INDEX metadata relative to most recent", () => {
      const messages = [
        { user: "U1", text: "oldest", ts: "1" },
        { user: "U1", text: "middle", ts: "2" },
        { user: "U1", text: "newest", ts: "3" },
      ];

      const result = formatContextForAgent(messages);

      // Three messages: indices 0,1,2 → relative -3, -2, -1
      expect(result).toContain("RELATIVE_INDEX: -3");
      expect(result).toContain("RELATIVE_INDEX: -2");
      expect(result).toContain("RELATIVE_INDEX: -1");
    });

    it("should return empty string for empty messages", () => {
      expect(formatContextForAgent([])).toBe("");
    });

    it("should resolve user mentions when userInfoMap is provided", () => {
      const messages = [{ user: "U1", text: "hey <@U2> check this", ts: "1" }];
      const userInfoMap = new Map([
        ["U1", { id: "U1", name: "alice" }],
        ["U2", { id: "U2", name: "bob" }],
      ]);

      const result = formatContextForAgent(messages, "thread", userInfoMap);

      expect(result).toContain("@bob (U2)");
    });
  });
});

describe("Feature: Format Current Message Files", () => {
  it("should format each file with three-step instructions", () => {
    const files = [
      { id: "F1", name: "a.png", mimetype: "image/png", filetype: "png" },
      { id: "F2", name: "b.pdf", mimetype: "application/pdf", filetype: "pdf" },
    ];

    const result = formatCurrentMessageFiles(files);

    expect(result).toContain(
      "Step 1 - Download: zero slack download-file F1 -o /tmp/F1.png",
    );
    expect(result).toContain(
      "Step 1 - Download: zero slack download-file F2 -o /tmp/F2.pdf",
    );
  });

  it("should return empty string for empty file array", () => {
    expect(formatCurrentMessageFiles([])).toBe("");
  });
});

describe("Feature: Extract Text From Blocks", () => {
  it("should extract plain text from rich_text_section", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "text", text: "hello world" }],
          },
        ],
      },
    ];

    expect(extractTextFromBlocks(blocks)).toBe("hello world");
  });

  it("should apply bold style wrapper", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "text", text: "bold", style: { bold: true } }],
          },
        ],
      },
    ];

    expect(extractTextFromBlocks(blocks)).toBe("**bold**");
  });

  it("should return undefined when no rich_text blocks present", () => {
    expect(extractTextFromBlocks([])).toBeUndefined();
    expect(extractTextFromBlocks(undefined)).toBeUndefined();
    expect(extractTextFromBlocks([{ type: "section" }])).toBeUndefined();
  });
});

describe("Feature: Extract Mentioned User IDs", () => {
  it("should collect user IDs from rich_text user elements", () => {
    const messages = [
      {
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "user", user_id: "U42" }],
              },
            ],
          },
        ],
      },
    ];

    expect(extractMentionedUserIds(messages)).toEqual(["U42"]);
  });

  it("should collect user IDs from plain text fallback", () => {
    const messages = [{ text: "hey <@U1> and <@U2>" }];

    expect(extractMentionedUserIds(messages)).toEqual(["U1", "U2"]);
  });

  it("should deduplicate user IDs across blocks and text", () => {
    const messages = [
      {
        text: "<@U1>",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "user", user_id: "U1" }],
              },
            ],
          },
        ],
      },
    ];

    expect(extractMentionedUserIds(messages)).toEqual(["U1"]);
  });
});
