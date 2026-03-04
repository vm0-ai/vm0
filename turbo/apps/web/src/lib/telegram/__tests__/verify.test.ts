import { describe, it, expect } from "vitest";
import { verifyTelegramWebhook } from "../verify";

function makeRequest(headers: Record<string, string>): Request {
  return new Request("https://example.com/webhook", { headers });
}

describe("verifyTelegramWebhook", () => {
  const secret = "test-webhook-secret-token-abc123";

  it("should return true for valid secret", () => {
    const request = makeRequest({
      "x-telegram-bot-api-secret-token": secret,
    });

    expect(verifyTelegramWebhook(request, secret)).toBe(true);
  });

  it("should return false for invalid secret", () => {
    const request = makeRequest({
      "x-telegram-bot-api-secret-token": "wrong-secret",
    });

    expect(verifyTelegramWebhook(request, secret)).toBe(false);
  });

  it("should return false for missing header", () => {
    const request = makeRequest({});

    expect(verifyTelegramWebhook(request, secret)).toBe(false);
  });

  it("should use timing-safe comparison (different length secrets)", () => {
    const request = makeRequest({
      "x-telegram-bot-api-secret-token": "short",
    });

    // Should not throw, should return false
    expect(verifyTelegramWebhook(request, secret)).toBe(false);
  });
});
