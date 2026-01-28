import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetToken = vi.fn();
const mockSaveConfig = vi.fn();
const mockGetApiUrl = vi.fn();

vi.mock("../../../api/config.js", () => ({
  getToken: () => mockGetToken(),
  saveConfig: (config: unknown) => mockSaveConfig(config),
  getApiUrl: () => mockGetApiUrl(),
}));

describe("auth", () => {
  let isAuthenticated: typeof import("../auth.js").isAuthenticated;
  let runAuthFlow: typeof import("../auth.js").runAuthFlow;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetApiUrl.mockResolvedValue("https://api.vm0.ai");

    const authModule = await import("../auth.js");
    isAuthenticated = authModule.isAuthenticated;
    runAuthFlow = authModule.runAuthFlow;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isAuthenticated", () => {
    it("should return true when token exists", async () => {
      mockGetToken.mockResolvedValue("test-token");

      const result = await isAuthenticated();

      expect(result).toBe(true);
    });

    it("should return false when no token", async () => {
      mockGetToken.mockResolvedValue(undefined);

      const result = await isAuthenticated();

      expect(result).toBe(false);
    });
  });

  describe("runAuthFlow", () => {
    const mockDeviceCodeResponse = {
      device_code: "device-code-123",
      user_code: "USER-CODE",
      verification_path: "/cli-auth",
      expires_in: 900,
      interval: 5,
    };

    const mockTokenResponse = {
      access_token: "access-token-123",
    };

    it("should call callbacks in correct order on success", async () => {
      const callbacks = {
        onInitiating: vi.fn(),
        onDeviceCodeReady: vi.fn(),
        onPolling: vi.fn(),
        onSuccess: vi.fn(),
        onError: vi.fn(),
      };

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockDeviceCodeResponse),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTokenResponse),
        } as Response);

      await runAuthFlow(callbacks);

      expect(callbacks.onInitiating).toHaveBeenCalled();
      expect(callbacks.onDeviceCodeReady).toHaveBeenCalledWith(
        "https://api.vm0.ai/cli-auth",
        "USER-CODE",
        15,
      );
      expect(callbacks.onSuccess).toHaveBeenCalled();
      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(mockSaveConfig).toHaveBeenCalledWith({
        token: "access-token-123",
        apiUrl: "https://api.vm0.ai",
      });
    });

    it("should call onError on expired token", async () => {
      const callbacks = {
        onError: vi.fn(),
      };

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockDeviceCodeResponse),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ error: "expired_token" }),
        } as Response);

      await expect(runAuthFlow(callbacks)).rejects.toThrow(
        "The device code has expired",
      );
      expect(callbacks.onError).toHaveBeenCalled();
    });

    it("should throw on failed device code request", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        statusText: "Internal Server Error",
      } as Response);

      await expect(runAuthFlow()).rejects.toThrow(
        "Failed to request device code",
      );
    });

    it("should handle auth errors with description", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockDeviceCodeResponse),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              error: "access_denied",
              error_description: "User denied access",
            }),
        } as Response);

      await expect(runAuthFlow()).rejects.toThrow(
        "Authentication failed: User denied access",
      );
    });
  });
});
