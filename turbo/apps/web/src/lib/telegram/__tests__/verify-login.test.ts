import { createHmac, createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyTelegramLogin, type TelegramAuthData } from "../verify-login";

const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

function makeAuth(overrides?: Partial<TelegramAuthData>): TelegramAuthData {
  const now = Math.floor(Date.now() / 1000);
  const base: Omit<TelegramAuthData, "hash"> = {
    id: 12345,
    first_name: "Test",
    auth_date: now,
    ...overrides,
  };

  // Build data-check-string exactly as Telegram specifies
  const checkString = Object.entries(base)
    .filter(([, value]) => {
      return value !== undefined;
    })
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    })
    .map(([key, value]) => {
      return `${key}=${value}`;
    })
    .join("\n");

  const secretKey = createHash("sha256").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  return { ...base, hash } as TelegramAuthData;
}

describe("verifyTelegramLogin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true for valid auth data", () => {
    const auth = makeAuth();
    expect(verifyTelegramLogin(auth, BOT_TOKEN)).toBe(true);
  });

  it("returns false for wrong bot token", () => {
    const auth = makeAuth();
    expect(verifyTelegramLogin(auth, "wrong-token")).toBe(false);
  });

  it("returns false for tampered data", () => {
    const auth = makeAuth();
    auth.first_name = "Tampered";
    expect(verifyTelegramLogin(auth, BOT_TOKEN)).toBe(false);
  });

  it("returns false for expired auth_date", () => {
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow);
    const past = Math.floor(realNow / 1000) - 400; // 400s ago, > 300s limit
    const auth = makeAuth({ auth_date: past });
    expect(verifyTelegramLogin(auth, BOT_TOKEN)).toBe(false);
  });

  it("includes optional fields in verification", () => {
    const auth = makeAuth({
      username: "testuser",
      last_name: "User",
      photo_url: "https://example.com/photo.jpg",
    });
    expect(verifyTelegramLogin(auth, BOT_TOKEN)).toBe(true);
  });
});
