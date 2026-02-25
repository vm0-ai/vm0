import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { Resend } from "resend";
import { processEmailAttachments } from "../attachment";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { http } from "../../../__tests__/msw";

const context = testContext();
const mockResend = vi.mocked(new Resend(""), true);

describe("Feature: Email Attachment Processing", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("Scenario: No attachments", () => {
    it("should return empty string when email has no attachments", async () => {
      const result = await processEmailAttachments("email-no-att");

      expect(result).toBe("");
      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
    });
  });

  describe("Scenario: Single attachment downloaded and uploaded", () => {
    it("should download attachment, upload to R2, and return formatted prompt", async () => {
      const pdfBuffer = Buffer.from("fake-pdf-content");

      mockResend.emails.receiving.attachments.list.mockResolvedValueOnce({
        data: {
          object: "list",
          has_more: false,
          data: [
            {
              id: "att-123",
              filename: "report.pdf",
              size: 5000,
              content_type: "application/pdf",
              content_disposition: "attachment",
              download_url: "https://download.resend.com/att-123",
            },
          ],
        },
      } as never);

      const downloadHandler = http.get(
        "https://download.resend.com/att-123",
        () => {
          return new HttpResponse(pdfBuffer, {
            headers: { "content-type": "application/pdf" },
          });
        },
      );
      server.use(downloadHandler.handler);

      const result = await processEmailAttachments("email-123");

      expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledWith(
        "test-bucket",
        "email-attachments/email-123/att-123-report.pdf",
        expect.any(Buffer),
        "application/pdf",
      );
      expect(context.mocks.s3.generatePresignedUrl).toHaveBeenCalledWith(
        "test-bucket",
        "email-attachments/email-123/att-123-report.pdf",
        3600,
      );
      expect(result).toContain("[attachment]: report.pdf");
      expect(result).toContain("application/pdf");
      expect(result).toContain("https://mock-presigned-url");
      expect(result).toContain("curl -sS -o /tmp/report.pdf");
    });
  });

  describe("Scenario: Multiple attachments", () => {
    it("should process multiple attachments and return formatted prompt for each", async () => {
      const pdfBuffer = Buffer.from("fake-pdf");
      const csvBuffer = Buffer.from("col1,col2\nval1,val2");

      mockResend.emails.receiving.attachments.list.mockResolvedValueOnce({
        data: {
          object: "list",
          has_more: false,
          data: [
            {
              id: "att-1",
              filename: "report.pdf",
              size: 5000,
              content_type: "application/pdf",
              content_disposition: "attachment",
              download_url: "https://download.resend.com/att-1",
            },
            {
              id: "att-2",
              filename: "data.csv",
              size: 200,
              content_type: "text/csv",
              content_disposition: "attachment",
              download_url: "https://download.resend.com/att-2",
            },
          ],
        },
      } as never);

      const handler1 = http.get("https://download.resend.com/att-1", () => {
        return new HttpResponse(pdfBuffer, {
          headers: { "content-type": "application/pdf" },
        });
      });
      const handler2 = http.get("https://download.resend.com/att-2", () => {
        return new HttpResponse(csvBuffer, {
          headers: { "content-type": "text/csv" },
        });
      });
      server.use(handler1.handler, handler2.handler);

      const result = await processEmailAttachments("email-multi");

      expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledTimes(2);
      expect(result).toContain("report.pdf");
      expect(result).toContain("data.csv");
    });
  });

  describe("Scenario: Oversized attachment", () => {
    it("should skip attachment that exceeds 10MB size limit", async () => {
      mockResend.emails.receiving.attachments.list.mockResolvedValueOnce({
        data: {
          object: "list",
          has_more: false,
          data: [
            {
              id: "att-big",
              filename: "large-file.zip",
              size: 15 * 1024 * 1024, // 15MB
              content_type: "application/zip",
              content_disposition: "attachment",
              download_url: "https://download.resend.com/att-big",
            },
          ],
        },
      } as never);

      const result = await processEmailAttachments("email-big");

      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
      expect(result).toContain("large-file.zip");
      expect(result).toContain("skipped: exceeds size limit");
    });
  });

  describe("Scenario: Download failure", () => {
    it("should skip attachment when download returns error", async () => {
      mockResend.emails.receiving.attachments.list.mockResolvedValueOnce({
        data: {
          object: "list",
          has_more: false,
          data: [
            {
              id: "att-fail",
              filename: "broken.pdf",
              size: 5000,
              content_type: "application/pdf",
              content_disposition: "attachment",
              download_url: "https://download.resend.com/att-fail",
            },
          ],
        },
      } as never);

      const downloadHandler = http.get(
        "https://download.resend.com/att-fail",
        () => {
          return new HttpResponse(null, { status: 500 });
        },
      );
      server.use(downloadHandler.handler);

      const result = await processEmailAttachments("email-fail");

      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
      expect(result).toContain("broken.pdf");
      expect(result).toContain("skipped: download failed");
    });
  });

  describe("Scenario: Mixed results", () => {
    it("should handle mix of successful and failed downloads", async () => {
      const pdfBuffer = Buffer.from("good-pdf");

      mockResend.emails.receiving.attachments.list.mockResolvedValueOnce({
        data: {
          object: "list",
          has_more: false,
          data: [
            {
              id: "att-good",
              filename: "good.pdf",
              size: 5000,
              content_type: "application/pdf",
              content_disposition: "attachment",
              download_url: "https://download.resend.com/att-good",
            },
            {
              id: "att-bad",
              filename: "bad.pdf",
              size: 5000,
              content_type: "application/pdf",
              content_disposition: "attachment",
              download_url: "https://download.resend.com/att-bad",
            },
          ],
        },
      } as never);

      const goodHandler = http.get(
        "https://download.resend.com/att-good",
        () => {
          return new HttpResponse(pdfBuffer, {
            headers: { "content-type": "application/pdf" },
          });
        },
      );
      const badHandler = http.get("https://download.resend.com/att-bad", () => {
        return HttpResponse.error();
      });
      server.use(goodHandler.handler, badHandler.handler);

      const result = await processEmailAttachments("email-mixed");

      expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledTimes(1);
      expect(result).toContain("[attachment]: good.pdf");
      expect(result).toContain("https://mock-presigned-url");
      expect(result).toContain("[attachment]: bad.pdf");
      expect(result).toContain("skipped: download failed");
    });
  });
});
