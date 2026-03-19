import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import {
  formatContextForAgent,
  formatContextForAgentWithImages,
  formatCurrentMessageFiles,
  extractMessageContent,
  extractTextFromBlocks,
} from "../context";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { http } from "../../../__tests__/msw";

// Mock external dependencies required by testContext().setupMocks()

const context = testContext();

describe("Feature: Format Context For Agent", () => {
  describe("Scenario: Format thread messages into context string", () => {
    it("should include all messages with structured metadata", () => {
      const messages = [
        { user: "U123", text: "Hello, can you help me?", ts: "1234567890.001" },
        { user: "U456", text: "Sure, what do you need?", ts: "1234567890.002" },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("# Slack Thread Context");
      expect(result).toContain("- RELATIVE_INDEX: -2");
      expect(result).toContain("- SENDER: {id: U123}");
      expect(result).toContain("Hello, can you help me?");
      expect(result).toContain("- RELATIVE_INDEX: -1");
      expect(result).toContain("- SENDER: {id: U456}");
      expect(result).toContain("Sure, what do you need?");
    });

    it("should use --- separators between messages", () => {
      const messages = [
        { user: "U123", text: "First", ts: "1234567890.001" },
        { user: "U456", text: "Second", ts: "1234567890.002" },
      ];

      const result = formatContextForAgent(messages);

      // Each message starts with --- and the output ends with ---
      expect(result).toMatch(/---\n\n- RELATIVE_INDEX: -2/);
      expect(result).toMatch(/---\n\n- RELATIVE_INDEX: -1/);
      expect(result).toMatch(/\n\n---$/);
    });
  });

  describe("Scenario: Include bot messages in context", () => {
    it("should include bot messages with SENDER ID: BOT", () => {
      const messages = [
        { user: "U123", text: "Hello", ts: "1234567890.001" },
        { bot_id: "BBOT123", text: "Bot response", ts: "1234567890.002" },
        { user: "U456", text: "Thanks", ts: "1234567890.003" },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("- SENDER: {id: U123}");
      expect(result).toContain("- SENDER: {id: BOT}");
      expect(result).toContain("Bot response");
      expect(result).toContain("- SENDER: {id: U456}");
    });

    it("should not filter out any messages even when botUserId is provided", () => {
      const botUserId = "BBOT123";
      const messages = [
        { user: "U123", text: "User message 1", ts: "1234567890.001" },
        { user: "BBOT123", text: "Bot message", ts: "1234567890.002" },
        { user: "U456", text: "User message 2", ts: "1234567890.003" },
      ];

      const result = formatContextForAgent(messages, botUserId);

      // All messages should be included
      expect(result).toContain("User message 1");
      expect(result).toContain("- SENDER: {id: BBOT123}");
      expect(result).toContain("Bot message");
      expect(result).toContain("User message 2");
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

      expect(result).toContain("- SENDER: {id: unknown}");
      expect(result).toContain("No user");
      expect(result).toContain("- SENDER: {id: U123}");
    });
  });

  describe("Scenario: Format channel messages", () => {
    it("should use channel context header", () => {
      const messages = [
        { user: "U123", text: "Recent message", ts: "1234567890.001" },
      ];

      const result = formatContextForAgent(messages, undefined, "channel");

      expect(result).toContain("# Recent Channel Messages");
      expect(result).toContain("- SENDER: {id: U123}");
      expect(result).toContain("Recent message");
    });
  });

  describe("Scenario: Include files in context", () => {
    it("should format message with single image file", () => {
      const messages = [
        {
          user: "U123",
          text: "Check out this screenshot",
          ts: "1234567890.001",
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

      expect(result).toContain("Check out this screenshot");
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
          ts: "1234567890.001",
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
          ts: "1234567890.001",
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
          ts: "1234567890.001",
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
          ts: "1234567890.001",
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

      expect(result).toContain("Check this article");
      expect(result).toContain("[image]: Article Preview");
      expect(result).toContain("Dimensions: 800x600");
      expect(result).toContain(
        'View: curl -sS -o /tmp/attachment_image.jpg "https://example.com/preview.jpg"',
      );
    });

    it("should use fallback for attachment title", () => {
      const messages = [
        {
          user: "U123",
          text: "Link",
          ts: "1234567890.001",
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
      expect(result).toContain(
        'View: curl -sS -o /tmp/attachment_image.jpg "https://example.com/thumb.jpg"',
      );
    });

    it("should skip attachments without images", () => {
      const messages = [
        {
          user: "U123",
          text: "Text only attachment",
          ts: "1234567890.001",
          attachments: [
            {
              title: "No image here",
              fallback: "Just text",
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("Text only attachment");
      expect(result).not.toContain("[image]:");
    });
  });

  describe("Scenario: Mixed content in thread", () => {
    it("should format thread with text, files, and attachments", () => {
      const messages = [
        {
          user: "U123",
          text: "Here is the error screenshot",
          ts: "1234567890.001",
        },
        {
          user: "U456",
          text: "I see the issue",
          ts: "1234567890.002",
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
          ts: "1234567890.003",
          attachments: [
            {
              title: "Bug Report",
              image_url: "https://example.com/bug.jpg",
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("- RELATIVE_INDEX: -3");
      expect(result).toContain("Here is the error screenshot");
      expect(result).toContain("- RELATIVE_INDEX: -2");
      expect(result).toContain("I see the issue");
      expect(result).toContain("[file]: fix.png (PNG Image)");
      expect(result).toContain("Dimensions: 640x480");
      expect(result).toContain("- RELATIVE_INDEX: -1");
      expect(result).toContain("Related article");
      expect(result).toContain("[image]: Bug Report");
    });
  });

  describe("Scenario: Include context preamble with interpretation guidelines", () => {
    it("should include preamble between header and messages for thread context", () => {
      const messages = [{ user: "U123", text: "Hello", ts: "1234567890.001" }];

      const result = formatContextForAgent(messages);

      expect(result).toContain("Match the tone of the conversation");
      expect(result).toContain(
        "Only provide technical analysis when explicitly asked",
      );
      expect(result).toContain(
        "Keep responses proportional to the message length",
      );
    });

    it("should include preamble for channel context", () => {
      const messages = [{ user: "U123", text: "Hello", ts: "1234567890.001" }];

      const result = formatContextForAgent(messages, undefined, "channel");

      expect(result).toContain("Match the tone of the conversation");
    });

    it("should not include preamble for empty messages", () => {
      const result = formatContextForAgent([]);

      expect(result).toBe("");
    });
  });

  describe("Scenario: Relative index calculation", () => {
    it("should calculate relative index from the end of messages", () => {
      const messages = [
        { user: "U1", text: "First", ts: "1.0" },
        { user: "U2", text: "Second", ts: "2.0" },
        { user: "U3", text: "Third", ts: "3.0" },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("- RELATIVE_INDEX: -3");
      expect(result).toContain("- RELATIVE_INDEX: -2");
      expect(result).toContain("- RELATIVE_INDEX: -1");
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
          ts: "1234567890.001",
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
      expect(result).toContain(
        'View: curl -sS -o /tmp/F123.png "https://mock-presigned-url"',
      );
      expect(result).toContain("- SENDER: {id: U123}");
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
          ts: "1234567890.001",
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

      expect(result).toContain(
        'View: curl -sS -o /tmp/F456.png "https://mock-presigned-url"',
      );
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
          ts: "1234567890.001",
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
          ts: "1234567890.001",
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
          ts: "1234567890.001",
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
          ts: "1234567890.001",
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
          ts: "1234567890.001",
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
          ts: "1234567890.001",
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
          ts: "1234567890.001",
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
          ts: "1234567890.001",
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
      expect((result.match(/View: curl/g) || []).length).toBe(2);
    });
  });

  describe("Scenario: Include context preamble in image context", () => {
    it("should include preamble between header and messages", async () => {
      const messages = [
        {
          user: "U123",
          text: "Hello",
          ts: "1234567890.001",
        },
      ];

      const result = await formatContextForAgentWithImages(
        messages,
        "xoxb-test-token",
        "test-session-123",
      );

      expect(result).toContain("Match the tone of the conversation");
      expect(result).toContain(
        "Only provide technical analysis when explicitly asked",
      );
      expect(result).toContain(
        "Keep responses proportional to the message length",
      );
    });
  });

  describe("Scenario: Structured format for image context", () => {
    it("should include metadata in image context format", async () => {
      const messages = [
        {
          user: "U123",
          text: "Document",
          ts: "1234567890.001",
          files: [
            {
              name: "report.pdf",
              mimetype: "application/pdf",
              permalink: "https://slack.com/files/report.pdf",
            },
          ],
        },
        {
          user: "U456",
          text: "Response",
          ts: "1234567890.002",
        },
      ];

      const result = await formatContextForAgentWithImages(
        messages,
        "xoxb-test-token",
        "test-session-123",
      );

      expect(result).toContain("# Slack Thread Context");
      expect(result).toContain("- RELATIVE_INDEX: -2");
      expect(result).toContain("- SENDER: {id: U123}");
      expect(result).toContain("- RELATIVE_INDEX: -1");
      expect(result).toContain("- SENDER: {id: U456}");
    });
  });
});

describe("Feature: Extract Text From Rich Text Blocks", () => {
  describe("Scenario: Return undefined for missing or empty blocks", () => {
    it("should return undefined when blocks is undefined", () => {
      expect(extractTextFromBlocks(undefined)).toBeUndefined();
    });

    it("should return undefined when blocks array is empty", () => {
      expect(extractTextFromBlocks([])).toBeUndefined();
    });

    it("should return undefined when no rich_text blocks present", () => {
      expect(extractTextFromBlocks([{ type: "section" }])).toBeUndefined();
    });
  });

  describe("Scenario: Extract plain text from rich_text_section", () => {
    it("should extract simple text", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "Hello world" }],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("Hello world");
    });

    it("should preserve bold formatting", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "Hello " },
                { type: "text", text: "world", style: { bold: true } },
              ],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("Hello **world**");
    });

    it("should preserve italic formatting", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "emphasis", style: { italic: true } },
              ],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("_emphasis_");
    });

    it("should preserve inline code formatting", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "use " },
                { type: "text", text: "npm install", style: { code: true } },
              ],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("use `npm install`");
    });

    it("should preserve strikethrough formatting", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "removed", style: { strike: true } },
              ],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("~removed~");
    });
  });

  describe("Scenario: Handle links", () => {
    it("should format link with display text", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "link", url: "https://example.com", text: "Example" },
              ],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe(
        "[Example](https://example.com)",
      );
    });

    it("should format link without display text", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "link", url: "https://example.com" }],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe(
        "[https://example.com](https://example.com)",
      );
    });
  });

  describe("Scenario: Handle emoji", () => {
    it("should convert unicode emoji", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "emoji", name: "wave", unicode: "1f44b" }],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("\u{1f44b}");
    });

    it("should use colon notation for custom emoji", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "emoji", name: "partyparrot" }],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe(":partyparrot:");
    });
  });

  describe("Scenario: Handle mentions", () => {
    it("should format user mention", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "user", user_id: "U12345" }],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("<@U12345>");
    });

    it("should format channel mention", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "channel", channel_id: "C12345" }],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("<#C12345>");
    });

    it("should format broadcast", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "broadcast", range: "channel" }],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("@channel");
    });
  });

  describe("Scenario: Handle rich_text_list", () => {
    it("should format bullet list", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_list",
              style: "bullet",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "Item 1" }],
                },
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "Item 2" }],
                },
              ],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("- Item 1\n- Item 2");
    });

    it("should format ordered list", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_list",
              style: "ordered",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "First" }],
                },
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "Second" }],
                },
              ],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("1. First\n2. Second");
    });

    it("should handle indented lists", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_list",
              style: "bullet",
              indent: 1,
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "Sub-item" }],
                },
              ],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("  - Sub-item");
    });

    it("should handle ordered list with offset", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_list",
              style: "ordered",
              offset: 3,
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "Continued" }],
                },
              ],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("4. Continued");
    });
  });

  describe("Scenario: Handle rich_text_preformatted", () => {
    it("should format code block", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_preformatted",
              elements: [{ type: "text", text: "const x = 1;" }],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("```\nconst x = 1;\n```");
    });

    it("should include language annotation", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_preformatted",
              language: "typescript",
              elements: [{ type: "text", text: "const x: number = 1;" }],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe(
        "```typescript\nconst x: number = 1;\n```",
      );
    });
  });

  describe("Scenario: Handle rich_text_quote", () => {
    it("should format blockquote", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_quote",
              elements: [{ type: "text", text: "Quoted text" }],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("> Quoted text");
    });

    it("should handle multi-line quotes", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_quote",
              elements: [{ type: "text", text: "Line 1\nLine 2" }],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe("> Line 1\n> Line 2");
    });
  });

  describe("Scenario: Complex multi-section messages", () => {
    it("should combine multiple sections", () => {
      const blocks = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                {
                  type: "text",
                  text: "Project Summary",
                  style: { bold: true },
                },
              ],
            },
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "Here are the key points:" }],
            },
            {
              type: "rich_text_list",
              style: "bullet",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "Point A" }],
                },
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "Point B" }],
                },
              ],
            },
          ],
        },
      ];

      expect(extractTextFromBlocks(blocks)).toBe(
        "**Project Summary**\nHere are the key points:\n- Point A\n- Point B",
      );
    });
  });

  describe("Scenario: Integration with formatContextForAgent", () => {
    it("should prefer blocks content over text fallback", () => {
      const messages = [
        {
          user: "U123",
          text: "Short fallback",
          ts: "1234567890.001",
          blocks: [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: "Full rich text content with all details preserved",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain(
        "Full rich text content with all details preserved",
      );
      expect(result).not.toContain("Short fallback");
    });

    it("should fall back to text when no rich_text blocks", () => {
      const messages = [
        {
          user: "U123",
          text: "Plain text message",
          ts: "1234567890.001",
          blocks: [{ type: "section" }],
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("Plain text message");
    });

    it("should fall back to text when blocks is undefined", () => {
      const messages = [
        {
          user: "U123",
          text: "Plain text message",
          ts: "1234567890.001",
        },
      ];

      const result = formatContextForAgent(messages);

      expect(result).toContain("Plain text message");
    });
  });
});

describe("Feature: Format Current Message Files", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should format multiple files with image upload", async () => {
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const imageBuffer = Buffer.concat([pngMagic, Buffer.from("fake-content")]);

    const downloadHandler = http.get(
      "https://files.slack.com/files-pri/T123-F001/download/photo.png",
      () => {
        return new HttpResponse(imageBuffer, {
          headers: { "content-type": "image/png" },
        });
      },
    );
    server.use(downloadHandler.handler);

    const files = [
      {
        id: "F001",
        name: "photo.png",
        mimetype: "image/png",
        url_private_download:
          "https://files.slack.com/files-pri/T123-F001/download/photo.png",
      },
      {
        id: "F002",
        name: "readme.txt",
        mimetype: "text/plain",
        permalink: "https://slack.com/files/readme.txt",
      },
    ];

    const result = await formatCurrentMessageFiles(
      files,
      "xoxb-test-token",
      "test-session-456",
    );

    expect(result).toContain("[file]: photo.png (image/png)");
    expect(result).toContain("[file]: readme.txt (text/plain)");
    expect(result).toContain("View: curl");
    expect(result).toContain("URL: https://slack.com/files/readme.txt");
    expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledTimes(1);
  });

  it("should return empty string for empty files array", async () => {
    const result = await formatCurrentMessageFiles(
      [],
      "xoxb-test-token",
      "test-session-456",
    );

    expect(result).toBe("");
  });

  describe("Scenario: SSRF protection rejects non-Slack URLs", () => {
    it("should reject non-Slack domain and fall back to permalink", async () => {
      const files = [
        {
          id: "F100",
          name: "malicious.png",
          mimetype: "image/png",
          url_private_download: "https://evil.com/malicious.png",
          permalink: "https://slack.com/files/malicious.png",
        },
      ];

      const result = await formatCurrentMessageFiles(
        files,
        "xoxb-test-token",
        "test-session-ssrf",
      );

      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
      expect(result).toContain("URL: https://slack.com/files/malicious.png");
      expect(result).not.toContain("View: curl");
    });

    it("should reject private IP address URL", async () => {
      const files = [
        {
          id: "F101",
          name: "internal.png",
          mimetype: "image/png",
          url_private_download: "http://192.168.1.1/internal.png",
          permalink: "https://slack.com/files/internal.png",
        },
      ];

      const result = await formatCurrentMessageFiles(
        files,
        "xoxb-test-token",
        "test-session-ssrf",
      );

      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
      expect(result).toContain("URL: https://slack.com/files/internal.png");
      expect(result).not.toContain("View: curl");
    });

    it("should reject non-HTTPS Slack URL", async () => {
      const files = [
        {
          id: "F102",
          name: "file.png",
          mimetype: "image/png",
          url_private_download: "http://files.slack.com/file.png",
          permalink: "https://slack.com/files/file.png",
        },
      ];

      const result = await formatCurrentMessageFiles(
        files,
        "xoxb-test-token",
        "test-session-ssrf",
      );

      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
      expect(result).toContain("URL: https://slack.com/files/file.png");
      expect(result).not.toContain("View: curl");
    });

    it("should reject cloud metadata URL", async () => {
      const files = [
        {
          id: "F103",
          name: "metadata.png",
          mimetype: "image/png",
          url_private_download: "http://169.254.169.254/latest/meta-data",
          permalink: "https://slack.com/files/metadata.png",
        },
      ];

      const result = await formatCurrentMessageFiles(
        files,
        "xoxb-test-token",
        "test-session-ssrf",
      );

      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
      expect(result).toContain("URL: https://slack.com/files/metadata.png");
      expect(result).not.toContain("View: curl");
    });

    it("should reject invalid URL string", async () => {
      const files = [
        {
          id: "F104",
          name: "bad.png",
          mimetype: "image/png",
          url_private_download: "not-a-url",
          permalink: "https://slack.com/files/bad.png",
        },
      ];

      const result = await formatCurrentMessageFiles(
        files,
        "xoxb-test-token",
        "test-session-ssrf",
      );

      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
      expect(result).toContain("URL: https://slack.com/files/bad.png");
      expect(result).not.toContain("View: curl");
    });
  });
});
