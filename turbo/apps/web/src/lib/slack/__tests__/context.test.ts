import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import {
  formatContextForAgent,
  formatContextForAgentWithImages,
  extractMessageContent,
  parseExplicitAgentSelection,
} from "../context";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { http } from "../../../__tests__/msw";

// Mock external dependencies required by testContext().setupMocks()
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("Feature: Format Context For Agent", () => {
  describe("Scenario: Format thread messages into context string", () => {
    it("should include all messages with user IDs", () => {
      const messages = [
        { user: "U123", text: "Hello, can you help me?" },
        { user: "U456", text: "Sure, what do you need?" },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("## Slack Thread Context");
      expect(result).toContain("[U123]: Hello, can you help me?");
      expect(result).toContain("[U456]: Sure, what do you need?");
    });
  });

  describe("Scenario: Include bot messages in context", () => {
    it("should include bot messages labeled as 'bot'", () => {
      const messages = [
        { user: "U123", text: "Hello" },
        { bot_id: "BBOT123", text: "Bot response" },
        { user: "U456", text: "Thanks" },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("[U123]: Hello");
      expect(result).toContain("[bot]: Bot response");
      expect(result).toContain("[U456]: Thanks");
    });

    it("should not filter out any messages even when botUserId is provided", () => {
      const botUserId = "BBOT123";
      const messages = [
        { user: "U123", text: "User message 1" },
        { user: "BBOT123", text: "Bot message" },
        { user: "U456", text: "User message 2" },
      ];

      const result = formatContextForAgent(messages, botUserId);

      // All messages should be included
      expect(result).toContain("[U123]: User message 1");
      expect(result).toContain("[BBOT123]: Bot message");
      expect(result).toContain("[U456]: User message 2");
    });
  });

  describe("Scenario: Handle edge cases", () => {
    it("should return empty string for empty messages array", () => {
      const result = formatContextForAgent([]);

      expect(result).toBe("");
    });

    it("should handle messages with missing user or text", () => {
      const messages = [{ text: "No user" }, { user: "U123" }];

      const result = formatContextForAgent(messages);

      expect(result).toContain("[unknown]: No user");
      expect(result).toContain("[U123]: ");
    });
  });

  describe("Scenario: Format channel messages", () => {
    it("should use channel context header", () => {
      const messages = [{ user: "U123", text: "Recent message" }];

      const result = formatContextForAgent(messages, undefined, "channel");

      expect(result).toContain("## Recent Channel Messages");
      expect(result).toContain("[U123]: Recent message");
    });
  });

  describe("Scenario: Include files in context", () => {
    it("should format message with single image file", () => {
      const messages = [
        {
          user: "U123",
          text: "Check out this screenshot",
          files: [
            {
              name: "screenshot.png",
              pretty_type: "PNG Image",
              original_w: "1920",
              original_h: "1080",
              permalink_public: "https://files.slack.com/public/screenshot.png",
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("[U123]: Check out this screenshot");
      expect(result).toContain("[file]: screenshot.png (PNG Image)");
      expect(result).toContain("Dimensions: 1920x1080");
      expect(result).toContain(
        "URL: https://files.slack.com/public/screenshot.png",
      );
    });

    it("should format message with multiple files", () => {
      const messages = [
        {
          user: "U123",
          text: "Here are the files",
          files: [
            {
              name: "image1.png",
              pretty_type: "PNG Image",
              permalink: "https://slack.com/files/image1.png",
            },
            {
              name: "document.pdf",
              pretty_type: "PDF",
              permalink: "https://slack.com/files/document.pdf",
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("[file]: image1.png (PNG Image)");
      expect(result).toContain("[file]: document.pdf (PDF)");
    });

    it("should use thumbnail URL when public URL is not available", () => {
      const messages = [
        {
          user: "U123",
          text: "Private image",
          files: [
            {
              name: "private.png",
              mimetype: "image/png",
              thumb_480: "https://files.slack.com/thumb_480/private.png",
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("[file]: private.png (image/png)");
      expect(result).toContain(
        "URL: https://files.slack.com/thumb_480/private.png",
      );
    });

    it("should handle files without dimensions", () => {
      const messages = [
        {
          user: "U123",
          text: "A document",
          files: [
            {
              name: "report.docx",
              pretty_type: "Word Document",
              permalink: "https://slack.com/files/report.docx",
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("[file]: report.docx (Word Document)");
      expect(result).not.toContain("Dimensions:");
    });
  });

  describe("Scenario: Include attachments with images in context", () => {
    it("should format attachment with image URL", () => {
      const messages = [
        {
          user: "U123",
          text: "Check this article",
          attachments: [
            {
              title: "Article Preview",
              image_url: "https://example.com/preview.jpg",
              image_width: 800,
              image_height: 600,
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("[U123]: Check this article");
      expect(result).toContain("[image]: Article Preview");
      expect(result).toContain("Dimensions: 800x600");
      expect(result).toContain("URL: https://example.com/preview.jpg");
    });

    it("should use fallback for attachment title", () => {
      const messages = [
        {
          user: "U123",
          text: "Link",
          attachments: [
            {
              fallback: "Preview image",
              thumb_url: "https://example.com/thumb.jpg",
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("[image]: Preview image");
      expect(result).toContain("URL: https://example.com/thumb.jpg");
    });

    it("should skip attachments without images", () => {
      const messages = [
        {
          user: "U123",
          text: "Text only attachment",
          attachments: [
            {
              title: "No image here",
              fallback: "Just text",
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("[U123]: Text only attachment");
      expect(result).not.toContain("[image]:");
    });
  });

  describe("Scenario: Mixed content in thread", () => {
    it("should format thread with text, files, and attachments", () => {
      const messages = [
        { user: "U123", text: "Here is the error screenshot" },
        {
          user: "U456",
          text: "I see the issue",
          files: [
            {
              name: "fix.png",
              pretty_type: "PNG Image",
              original_w: "640",
              original_h: "480",
              permalink_public: "https://files.slack.com/fix.png",
            },
          ],
        },
        {
          user: "U123",
          text: "Related article",
          attachments: [
            {
              title: "Bug Report",
              image_url: "https://example.com/bug.jpg",
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("[U123]: Here is the error screenshot");
      expect(result).toContain("[U456]: I see the issue");
      expect(result).toContain("[file]: fix.png (PNG Image)");
      expect(result).toContain("Dimensions: 640x480");
      expect(result).toContain("[U123]: Related article");
      expect(result).toContain("[image]: Bug Report");
    });
  });
});

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

describe("Feature: Format Context With Image Upload", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("Scenario: Upload supported image types to R2", () => {
    it("should download PNG image and upload to R2 with presigned URL", async () => {
      // PNG magic bytes: 89 50 4E 47 (0x89 P N G)
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const imageBuffer = Buffer.concat([
        pngMagic,
        Buffer.from("fake-content"),
      ]);

      // Mock Slack file download via MSW
      const downloadHandler = http.get(
        "https://files.slack.com/files-pri/T123-F123/download/screenshot.png",
        () => {
          return new HttpResponse(imageBuffer, {
            headers: { "content-type": "image/png" },
          });
        },
      );
      server.use(downloadHandler.handler);

      const messages = [
        {
          user: "U123",
          text: "Check this screenshot",
          files: [
            {
              id: "F123",
              name: "screenshot.png",
              mimetype: "image/png",
              original_w: "1920",
              original_h: "1080",
              url_private_download:
                "https://files.slack.com/files-pri/T123-F123/download/screenshot.png",
            },
          ],
        },
      ];

      const result = await formatContextForAgentWithImages(
        messages,
        "xoxb-test-token",
        "test-session-123",
        "BBOT123",
        "thread",
      );

      expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalled();
      expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledWith(
        "test-bucket",
        expect.stringContaining("slack-images/test-session-123/"),
        expect.any(Buffer),
        "image/png",
      );
      expect(context.mocks.s3.generatePresignedUrl).toHaveBeenCalled();
      expect(result).toContain("[file]: screenshot.png (image/png)");
      expect(result).toContain("Dimensions: 1920x1080");
      expect(result).toContain("Image URL: https://mock-presigned-url");
    });

    it("should upload JPEG images to R2", async () => {
      // JPEG magic bytes: FF D8 FF
      const jpegMagic = Buffer.from([0xff, 0xd8, 0xff]);
      const imageBuffer = Buffer.concat([
        jpegMagic,
        Buffer.from("fake-content"),
      ]);

      const downloadHandler = http.get(
        "https://files.slack.com/download/photo.jpg",
        () => {
          return new HttpResponse(imageBuffer, {
            headers: { "content-type": "image/jpeg" },
          });
        },
      );
      server.use(downloadHandler.handler);

      const messages = [
        {
          user: "U123",
          text: "Photo",
          files: [
            {
              id: "F456",
              name: "photo.jpg",
              mimetype: "image/jpeg",
              url_private_download:
                "https://files.slack.com/download/photo.jpg",
            },
          ],
        },
      ];

      const result = await formatContextForAgentWithImages(
        messages,
        "xoxb-test-token",
        "test-session-123",
      );

      expect(result).toContain("Image URL: https://mock-presigned-url");
      expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledWith(
        "test-bucket",
        expect.stringContaining("slack-images/test-session-123/"),
        expect.any(Buffer),
        "image/jpeg",
      );
    });
  });

  describe("Scenario: Fall back to URL for unsupported types", () => {
    it("should not upload PDF files, use URL fallback", async () => {
      const messages = [
        {
          user: "U123",
          text: "Document",
          files: [
            {
              name: "report.pdf",
              mimetype: "application/pdf",
              url_private_download:
                "https://files.slack.com/download/report.pdf",
              permalink: "https://slack.com/files/report.pdf",
            },
          ],
        },
      ];

      const result = await formatContextForAgentWithImages(
        messages,
        "xoxb-test-token",
        "test-session-123",
      );

      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
      expect(result).toContain("[file]: report.pdf (application/pdf)");
      expect(result).toContain("URL: https://slack.com/files/report.pdf");
      expect(result).not.toContain("Image URL:");
    });
  });

  describe("Scenario: Handle download failures gracefully", () => {
    it("should fall back to URL when download fails", async () => {
      const downloadHandler = http.get(
        "https://files.slack.com/download/screenshot.png",
        () => {
          return new HttpResponse(null, { status: 401 });
        },
      );
      server.use(downloadHandler.handler);

      const messages = [
        {
          user: "U123",
          text: "Screenshot",
          files: [
            {
              id: "F123",
              name: "screenshot.png",
              mimetype: "image/png",
              url_private_download:
                "https://files.slack.com/download/screenshot.png",
              permalink: "https://slack.com/files/screenshot.png",
            },
          ],
        },
      ];

      const result = await formatContextForAgentWithImages(
        messages,
        "xoxb-test-token",
        "test-session-123",
      );

      expect(result).toContain("URL: https://slack.com/files/screenshot.png");
      expect(result).not.toContain("Image URL:");
    });

    it("should fall back to URL when fetch throws", async () => {
      const downloadHandler = http.get(
        "https://files.slack.com/download/screenshot.png",
        () => {
          return HttpResponse.error();
        },
      );
      server.use(downloadHandler.handler);

      const messages = [
        {
          user: "U123",
          text: "Screenshot",
          files: [
            {
              name: "screenshot.png",
              mimetype: "image/png",
              url_private_download:
                "https://files.slack.com/download/screenshot.png",
              thumb_480: "https://files.slack.com/thumb/screenshot.png",
            },
          ],
        },
      ];

      const result = await formatContextForAgentWithImages(
        messages,
        "xoxb-test-token",
        "test-session-123",
      );

      expect(result).toContain(
        "URL: https://files.slack.com/thumb/screenshot.png",
      );
      expect(result).not.toContain("Image URL:");
    });

    it("should fall back to URL when Slack returns HTML instead of image", async () => {
      const htmlContent = Buffer.from("<!DOCTYPE html><html>Login page</html>");
      const downloadHandler = http.get(
        "https://files.slack.com/download/screenshot.png",
        () => {
          return new HttpResponse(htmlContent, {
            headers: { "content-type": "text/html" },
          });
        },
      );
      server.use(downloadHandler.handler);

      const messages = [
        {
          user: "U123",
          text: "Screenshot",
          files: [
            {
              id: "F123",
              name: "screenshot.png",
              mimetype: "image/png",
              url_private_download:
                "https://files.slack.com/download/screenshot.png",
              permalink: "https://slack.com/files/screenshot.png",
            },
          ],
        },
      ];

      const result = await formatContextForAgentWithImages(
        messages,
        "xoxb-test-token",
        "test-session-123",
      );

      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
      expect(result).toContain("URL: https://slack.com/files/screenshot.png");
      expect(result).not.toContain("Image URL:");
    });

    it("should fall back to URL when content has invalid image magic bytes", async () => {
      const invalidContent = Buffer.from("Not an image file content");
      const downloadHandler = http.get(
        "https://files.slack.com/download/screenshot.png",
        () => {
          return new HttpResponse(invalidContent, {
            headers: { "content-type": "image/png" },
          });
        },
      );
      server.use(downloadHandler.handler);

      const messages = [
        {
          user: "U123",
          text: "Screenshot",
          files: [
            {
              id: "F123",
              name: "screenshot.png",
              mimetype: "image/png",
              url_private_download:
                "https://files.slack.com/download/screenshot.png",
              permalink: "https://slack.com/files/screenshot.png",
            },
          ],
        },
      ];

      const result = await formatContextForAgentWithImages(
        messages,
        "xoxb-test-token",
        "test-session-123",
      );

      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
      expect(result).toContain("URL: https://slack.com/files/screenshot.png");
      expect(result).not.toContain("Image URL:");
    });
  });

  describe("Scenario: Respect file size limits", () => {
    it("should not upload files larger than 10MB", async () => {
      const messages = [
        {
          user: "U123",
          text: "Large image",
          files: [
            {
              name: "large.png",
              mimetype: "image/png",
              size: 15 * 1024 * 1024, // 15MB (exceeds 10MB limit)
              url_private_download:
                "https://files.slack.com/download/large.png",
              permalink: "https://slack.com/files/large.png",
            },
          ],
        },
      ];

      const result = await formatContextForAgentWithImages(
        messages,
        "xoxb-test-token",
        "test-session-123",
      );

      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
      expect(result).toContain("URL: https://slack.com/files/large.png");
      expect(result).not.toContain("Image URL:");
    });
  });

  describe("Scenario: Handle files without url_private_download", () => {
    it("should use URL fallback when no download URL available", async () => {
      const messages = [
        {
          user: "U123",
          text: "Old image",
          files: [
            {
              name: "old.png",
              mimetype: "image/png",
              permalink_public: "https://files.slack.com/public/old.png",
            },
          ],
        },
      ];

      const result = await formatContextForAgentWithImages(
        messages,
        "xoxb-test-token",
        "test-session-123",
      );

      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
      expect(result).toContain("URL: https://files.slack.com/public/old.png");
    });
  });

  describe("Scenario: Handle multiple files in one message", () => {
    it("should upload multiple images", async () => {
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const imageBuffer1 = Buffer.concat([pngMagic, Buffer.from("image1")]);
      const imageBuffer2 = Buffer.concat([pngMagic, Buffer.from("image2")]);

      const handler1 = http.get(
        "https://files.slack.com/download/img1.png",
        () => {
          return new HttpResponse(imageBuffer1, {
            headers: { "content-type": "image/png" },
          });
        },
      );
      const handler2 = http.get(
        "https://files.slack.com/download/img2.png",
        () => {
          return new HttpResponse(imageBuffer2, {
            headers: { "content-type": "image/png" },
          });
        },
      );
      server.use(handler1.handler, handler2.handler);

      const messages = [
        {
          user: "U123",
          text: "Two images",
          files: [
            {
              id: "F1",
              name: "img1.png",
              mimetype: "image/png",
              url_private_download: "https://files.slack.com/download/img1.png",
            },
            {
              id: "F2",
              name: "img2.png",
              mimetype: "image/png",
              url_private_download: "https://files.slack.com/download/img2.png",
            },
          ],
        },
      ];

      const result = await formatContextForAgentWithImages(
        messages,
        "xoxb-test-token",
        "test-session-123",
      );

      expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledTimes(2);
      expect(result).toContain("[file]: img1.png");
      expect(result).toContain("[file]: img2.png");
      // Both should have presigned URLs
      expect((result.match(/Image URL:/g) || []).length).toBe(2);
    });
  });
});

describe("Feature: Parse Explicit Agent Selection", () => {
  describe("Scenario: Parse 'use <agent>' pattern", () => {
    it("should parse agent name and remaining message", () => {
      const message = "use my-coder fix this bug";

      const result = parseExplicitAgentSelection(message);

      expect(result).toEqual({
        agentName: "my-coder",
        remainingMessage: "fix this bug",
      });
    });

    it("should be case insensitive", () => {
      const message = "USE My-Agent do something";

      const result = parseExplicitAgentSelection(message);

      expect(result).toEqual({
        agentName: "My-Agent",
        remainingMessage: "do something",
      });
    });

    it("should handle agent name only (no remaining message)", () => {
      const message = "use github-agent";

      const result = parseExplicitAgentSelection(message);

      expect(result).toEqual({
        agentName: "github-agent",
        remainingMessage: "",
      });
    });
  });

  describe("Scenario: Handle invalid patterns", () => {
    it("should return null for messages without 'use' pattern", () => {
      const message = "just a regular message";

      const result = parseExplicitAgentSelection(message);

      expect(result).toBeNull();
    });

    it("should return null for 'use' without agent name", () => {
      const message = "use ";

      const result = parseExplicitAgentSelection(message);

      expect(result).toBeNull();
    });
  });
});
