import { describe, it, expect, vi, afterEach } from "vitest";
import { signConnectParams, verifyConnectSignature } from "../connect-token";

const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
const INSTALLATION_ID = "inst-001";
const TELEGRAM_USER_ID = "99999";

describe("connect-token", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("signConnectParams", () => {
    it("returns a hex string", () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = signConnectParams(
        INSTALLATION_ID,
        TELEGRAM_USER_ID,
        timestamp,
        BOT_TOKEN,
      );
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces different signatures for different inputs", () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const sig1 = signConnectParams(
        INSTALLATION_ID,
        TELEGRAM_USER_ID,
        timestamp,
        BOT_TOKEN,
      );
      const sig2 = signConnectParams(
        INSTALLATION_ID,
        "other-user",
        timestamp,
        BOT_TOKEN,
      );
      expect(sig1).not.toBe(sig2);
    });
  });

  describe("verifyConnectSignature", () => {
    it("returns true for valid signature", () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = signConnectParams(
        INSTALLATION_ID,
        TELEGRAM_USER_ID,
        timestamp,
        BOT_TOKEN,
      );
      expect(
        verifyConnectSignature(
          INSTALLATION_ID,
          TELEGRAM_USER_ID,
          timestamp,
          sig,
          BOT_TOKEN,
        ),
      ).toBe(true);
    });

    it("returns false for wrong bot token", () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = signConnectParams(
        INSTALLATION_ID,
        TELEGRAM_USER_ID,
        timestamp,
        BOT_TOKEN,
      );
      expect(
        verifyConnectSignature(
          INSTALLATION_ID,
          TELEGRAM_USER_ID,
          timestamp,
          sig,
          "wrong-token",
        ),
      ).toBe(false);
    });

    it("returns false for tampered installation id", () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = signConnectParams(
        INSTALLATION_ID,
        TELEGRAM_USER_ID,
        timestamp,
        BOT_TOKEN,
      );
      expect(
        verifyConnectSignature(
          "tampered-id",
          TELEGRAM_USER_ID,
          timestamp,
          sig,
          BOT_TOKEN,
        ),
      ).toBe(false);
    });

    it("returns false for expired timestamp", () => {
      const realNow = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(realNow);
      const expired = Math.floor(realNow / 1000) - 700; // > 600s limit
      const sig = signConnectParams(
        INSTALLATION_ID,
        TELEGRAM_USER_ID,
        expired,
        BOT_TOKEN,
      );
      expect(
        verifyConnectSignature(
          INSTALLATION_ID,
          TELEGRAM_USER_ID,
          expired,
          sig,
          BOT_TOKEN,
        ),
      ).toBe(false);
    });
  });
});
