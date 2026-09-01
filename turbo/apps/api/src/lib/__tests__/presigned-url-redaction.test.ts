import { describe, expect, it } from "vitest";

import { redactPresignedUrls } from "../presigned-url-redaction";

describe("redactPresignedUrls", () => {
  it("redacts an AWS-compatible presigned URL embedded in provider text", () => {
    const value = JSON.stringify({
      error:
        "download failed: https://r2.example.com/bucket/reference.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=secret&X-Amz-Signature=signature",
    });

    expect(redactPresignedUrls(value)).toBe(
      '{"error":"download failed: [redacted presigned URL]"}',
    );
  });

  it("preserves ordinary public URLs", () => {
    const value =
      "download failed: https://example.com/reference.png?version=latest";

    expect(redactPresignedUrls(value)).toBe(value);
  });
});
