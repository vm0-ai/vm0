/**
 * @vitest-environment node
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { eq } from "drizzle-orm";
import { initServices } from "../../init-services";
import { userSecrets } from "../../../db/schema/user-secrets";
import {
  upsertSecret,
  listSecrets,
  deleteSecret,
  getSecretValues,
} from "../secrets-service";

// Test user ID for isolation
const TEST_USER_ID = "test-user-secrets-service";

describe("secrets-service", () => {
  beforeAll(() => {
    initServices();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // Clean up test data before each test
    await globalThis.services.db
      .delete(userSecrets)
      .where(eq(userSecrets.userId, TEST_USER_ID));
  });

  afterAll(async () => {
    // Final cleanup
    await globalThis.services.db
      .delete(userSecrets)
      .where(eq(userSecrets.userId, TEST_USER_ID));
  });

  describe("upsertSecret", () => {
    it("creates new secret when none exists", async () => {
      const result = await upsertSecret(
        TEST_USER_ID,
        "API_KEY",
        "secret-value",
      );

      expect(result).toEqual({ action: "created" });

      // Verify secret was actually created in database
      const secrets = await globalThis.services.db
        .select()
        .from(userSecrets)
        .where(eq(userSecrets.userId, TEST_USER_ID));

      expect(secrets).toHaveLength(1);
      expect(secrets[0]!.name).toBe("API_KEY");
      expect(secrets[0]!.encryptedValue).toBeDefined();
      // Encrypted value should not be the plaintext
      expect(secrets[0]!.encryptedValue).not.toBe("secret-value");
    });

    it("updates existing secret", async () => {
      // Create initial secret
      await upsertSecret(TEST_USER_ID, "API_KEY", "initial-value");

      // Update the secret
      const result = await upsertSecret(TEST_USER_ID, "API_KEY", "new-value");

      expect(result).toEqual({ action: "updated" });

      // Verify only one secret exists and it was updated
      const secrets = await globalThis.services.db
        .select()
        .from(userSecrets)
        .where(eq(userSecrets.userId, TEST_USER_ID));

      expect(secrets).toHaveLength(1);
      expect(secrets[0]!.name).toBe("API_KEY");
    });
  });

  describe("listSecrets", () => {
    it("returns empty array when no secrets exist", async () => {
      const result = await listSecrets(TEST_USER_ID);

      expect(result).toEqual([]);
    });

    it("returns list of secrets with metadata", async () => {
      // Create some secrets
      await upsertSecret(TEST_USER_ID, "API_KEY", "value1");
      await upsertSecret(TEST_USER_ID, "DB_PASSWORD", "value2");

      const result = await listSecrets(TEST_USER_ID);

      expect(result).toHaveLength(2);
      // Secrets should be ordered by name
      expect(result[0]!.name).toBe("API_KEY");
      expect(result[1]!.name).toBe("DB_PASSWORD");
      // Should have ISO timestamp strings
      expect(result[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result[0]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("deleteSecret", () => {
    it("returns true when secret is deleted", async () => {
      // Create a secret first
      await upsertSecret(TEST_USER_ID, "TO_DELETE", "value");

      const result = await deleteSecret(TEST_USER_ID, "TO_DELETE");

      expect(result).toBe(true);

      // Verify secret was actually deleted
      const secrets = await globalThis.services.db
        .select()
        .from(userSecrets)
        .where(eq(userSecrets.userId, TEST_USER_ID));

      expect(secrets).toHaveLength(0);
    });

    it("returns false when secret not found", async () => {
      const result = await deleteSecret(TEST_USER_ID, "NONEXISTENT");

      expect(result).toBe(false);
    });
  });

  describe("getSecretValues", () => {
    it("returns empty object for empty names array", async () => {
      const result = await getSecretValues(TEST_USER_ID, []);

      expect(result).toEqual({});
    });

    it("returns decrypted secret values", async () => {
      // Create secrets with known values
      await upsertSecret(TEST_USER_ID, "API_KEY", "secret-123");
      await upsertSecret(TEST_USER_ID, "DB_PASSWORD", "password-456");

      const result = await getSecretValues(TEST_USER_ID, [
        "API_KEY",
        "DB_PASSWORD",
      ]);

      expect(result).toEqual({
        API_KEY: "secret-123",
        DB_PASSWORD: "password-456",
      });
    });

    it("only returns requested secrets", async () => {
      // Create multiple secrets
      await upsertSecret(TEST_USER_ID, "API_KEY", "secret-123");
      await upsertSecret(TEST_USER_ID, "DB_PASSWORD", "password-456");
      await upsertSecret(TEST_USER_ID, "OTHER_SECRET", "other-value");

      // Only request one
      const result = await getSecretValues(TEST_USER_ID, ["API_KEY"]);

      expect(result).toEqual({
        API_KEY: "secret-123",
      });
    });

    it("returns empty values for non-existent secrets", async () => {
      await upsertSecret(TEST_USER_ID, "API_KEY", "secret-123");

      const result = await getSecretValues(TEST_USER_ID, [
        "API_KEY",
        "NONEXISTENT",
      ]);

      // Only returns the existing secret
      expect(result).toEqual({
        API_KEY: "secret-123",
      });
    });
  });
});
