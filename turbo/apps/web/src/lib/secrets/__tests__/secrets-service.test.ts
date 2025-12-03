import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock crypto module to avoid env() access during module load
vi.mock("../crypto", () => ({
  encryptSecret: vi.fn((value: string) => `encrypted:${value}`),
  decryptSecret: vi.fn((value: string) => value.replace("encrypted:", "")),
}));

import {
  upsertSecret,
  listSecrets,
  deleteSecret,
  getSecretValues,
} from "../secrets-service";

describe("secrets-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("upsertSecret", () => {
    it("creates new secret when none exists", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockResolvedValue(undefined),
      };

      globalThis.services = { db: mockDb as never } as never;

      const result = await upsertSecret("user-1", "API_KEY", "secret-value");

      expect(result).toEqual({ action: "created" });
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith({
        userId: "user-1",
        name: "API_KEY",
        encryptedValue: "encrypted:secret-value",
      });
    });

    it("updates existing secret", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ id: "existing-id" }]),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
      };

      // Chain the where after set for update
      mockDb.set = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      globalThis.services = { db: mockDb as never } as never;

      const result = await upsertSecret("user-1", "API_KEY", "new-value");

      expect(result).toEqual({ action: "updated" });
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe("listSecrets", () => {
    it("returns empty array when no secrets exist", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockResolvedValue([]),
      };

      globalThis.services = { db: mockDb as never } as never;

      const result = await listSecrets("user-1");

      expect(result).toEqual([]);
    });

    it("returns list of secrets with metadata", async () => {
      const now = new Date();
      const mockSecrets = [
        { name: "API_KEY", createdAt: now, updatedAt: now },
        { name: "DB_PASSWORD", createdAt: now, updatedAt: now },
      ];

      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockResolvedValue(mockSecrets),
      };

      globalThis.services = { db: mockDb as never } as never;

      const result = await listSecrets("user-1");

      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe("API_KEY");
      expect(result[1]!.name).toBe("DB_PASSWORD");
      expect(result[0]!.createdAt).toBe(now.toISOString());
    });
  });

  describe("deleteSecret", () => {
    it("returns true when secret is deleted", async () => {
      const mockDb = {
        delete: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: "deleted-id" }]),
      };

      globalThis.services = { db: mockDb as never } as never;

      const result = await deleteSecret("user-1", "API_KEY");

      expect(result).toBe(true);
    });

    it("returns false when secret not found", async () => {
      const mockDb = {
        delete: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([]),
      };

      globalThis.services = { db: mockDb as never } as never;

      const result = await deleteSecret("user-1", "NONEXISTENT");

      expect(result).toBe(false);
    });
  });

  describe("getSecretValues", () => {
    it("returns empty object for empty names array", async () => {
      const result = await getSecretValues("user-1", []);

      expect(result).toEqual({});
    });

    it("returns decrypted secret values", async () => {
      const mockSecrets = [
        { name: "API_KEY", encryptedValue: "encrypted:secret-123" },
        { name: "DB_PASSWORD", encryptedValue: "encrypted:password-456" },
      ];

      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(mockSecrets),
      };

      globalThis.services = { db: mockDb as never } as never;

      const result = await getSecretValues("user-1", [
        "API_KEY",
        "DB_PASSWORD",
      ]);

      expect(result).toEqual({
        API_KEY: "secret-123",
        DB_PASSWORD: "password-456",
      });
    });

    it("only returns requested secrets", async () => {
      const mockSecrets = [
        { name: "API_KEY", encryptedValue: "encrypted:secret-123" },
      ];

      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(mockSecrets),
      };

      globalThis.services = { db: mockDb as never } as never;

      const result = await getSecretValues("user-1", ["API_KEY"]);

      expect(result).toEqual({
        API_KEY: "secret-123",
      });
    });
  });
});
