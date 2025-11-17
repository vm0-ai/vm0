import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { authenticate } from "../auth";
import { UnauthorizedError } from "../../errors";
import { createHash } from "crypto";

// Mock globalThis.services
const mockDb = {
  select: vi.fn(),
  update: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Setup globalThis.services mock
  Object.defineProperty(globalThis, "services", {
    value: { db: mockDb },
    configurable: true,
  });
});

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

describe("authenticate", () => {
  it("should throw UnauthorizedError when API key is missing", async () => {
    const request = new NextRequest("http://localhost/api/test");

    await expect(authenticate(request)).rejects.toThrow(UnauthorizedError);
    await expect(authenticate(request)).rejects.toThrow("Missing API key");
  });

  it("should throw UnauthorizedError when API key is invalid", async () => {
    const request = new NextRequest("http://localhost/api/test", {
      headers: { "x-api-key": "invalid-key" },
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    await expect(authenticate(request)).rejects.toThrow(UnauthorizedError);
    await expect(authenticate(request)).rejects.toThrow("Invalid API key");
  });

  it("should return API key ID when authentication succeeds", async () => {
    const apiKey = "valid-key-123";
    const apiKeyId = "api-key-id-123";
    const request = new NextRequest("http://localhost/api/test", {
      headers: { "x-api-key": apiKey },
    });

    const mockApiKeyRecord = {
      id: apiKeyId,
      keyHash: hashApiKey(apiKey),
      name: "Test Key",
      createdAt: new Date(),
      lastUsedAt: null,
    };

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([mockApiKeyRecord]),
        }),
      }),
    });

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const result = await authenticate(request);

    expect(result).toBe(apiKeyId);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("should update lastUsedAt timestamp on successful authentication", async () => {
    const apiKey = "valid-key-456";
    const apiKeyId = "api-key-id-456";
    const request = new NextRequest("http://localhost/api/test", {
      headers: { "x-api-key": apiKey },
    });

    const mockApiKeyRecord = {
      id: apiKeyId,
      keyHash: hashApiKey(apiKey),
      name: "Test Key 2",
      createdAt: new Date(),
      lastUsedAt: null,
    };

    const mockSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([mockApiKeyRecord]),
        }),
      }),
    });

    mockDb.update.mockReturnValue({
      set: mockSet,
    });

    await authenticate(request);

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        lastUsedAt: expect.any(Date),
      }),
    );
  });
});
