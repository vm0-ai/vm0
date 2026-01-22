/**
 * @vitest-environment node
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import {
  validateCredentialName,
  listCredentials,
  getCredential,
  getCredentialValue,
  getCredentialValues,
  setCredential,
  deleteCredential,
} from "../credential-service";
import { initServices } from "../../init-services";
import { credentials } from "../../../db/schema/credential";
import { scopes } from "../../../db/schema/scope";
import { eq } from "drizzle-orm";
import { BadRequestError, NotFoundError } from "../../errors";

describe("Credential Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validateCredentialName", () => {
    it("should accept valid names", () => {
      expect(() => validateCredentialName("MY_API_KEY")).not.toThrow();
      expect(() => validateCredentialName("GITHUB_TOKEN")).not.toThrow();
      expect(() => validateCredentialName("AWS_ACCESS_KEY_ID")).not.toThrow();
      expect(() => validateCredentialName("A")).not.toThrow();
      expect(() => validateCredentialName("A1B2C3")).not.toThrow();
      expect(() => validateCredentialName("KEY_123")).not.toThrow();
    });

    it("should reject empty names", () => {
      expect(() => validateCredentialName("")).toThrow(BadRequestError);
    });

    it("should reject names that are too long", () => {
      const longName = "A".repeat(256);
      expect(() => validateCredentialName(longName)).toThrow(BadRequestError);
    });

    it("should reject lowercase letters", () => {
      expect(() => validateCredentialName("my_api_key")).toThrow(
        BadRequestError,
      );
      expect(() => validateCredentialName("MyApiKey")).toThrow(BadRequestError);
    });

    it("should reject names starting with numbers", () => {
      expect(() => validateCredentialName("123_KEY")).toThrow(BadRequestError);
    });

    it("should reject invalid characters", () => {
      expect(() => validateCredentialName("MY-API-KEY")).toThrow(
        BadRequestError,
      );
      expect(() => validateCredentialName("MY.API.KEY")).toThrow(
        BadRequestError,
      );
      expect(() => validateCredentialName("MY API KEY")).toThrow(
        BadRequestError,
      );
    });
  });

  describe("Database Operations", () => {
    const testUserId = `test-credential-service-user-${Date.now()}`;
    const testSlug = `test-cred-scope-${Date.now()}`;
    let testScopeId: string;

    beforeAll(async () => {
      initServices();

      // Create a test scope
      const [scope] = await globalThis.services.db
        .insert(scopes)
        .values({
          slug: testSlug,
          type: "personal",
          ownerId: testUserId,
        })
        .returning();

      testScopeId = scope!.id;
    });

    afterAll(async () => {
      // Cleanup test credentials and scope
      await globalThis.services.db
        .delete(credentials)
        .where(eq(credentials.scopeId, testScopeId));
      await globalThis.services.db
        .delete(scopes)
        .where(eq(scopes.id, testScopeId));
    });

    describe("setCredential", () => {
      it("should create a credential successfully", async () => {
        const credential = await setCredential(
          testUserId,
          "TEST_API_KEY",
          "secret-value-123",
          "Test API key",
        );

        expect(credential).toBeDefined();
        expect(credential.name).toBe("TEST_API_KEY");
        expect(credential.description).toBe("Test API key");
        expect(credential.id).toBeDefined();
      });

      it("should update existing credential", async () => {
        // Create initial credential
        const initial = await setCredential(
          testUserId,
          "UPDATE_TEST_KEY",
          "initial-value",
        );

        // Update the credential
        const updated = await setCredential(
          testUserId,
          "UPDATE_TEST_KEY",
          "updated-value",
          "Updated description",
        );

        expect(updated.id).toBe(initial.id);
        expect(updated.description).toBe("Updated description");
        expect(updated.updatedAt.getTime()).toBeGreaterThan(
          initial.updatedAt.getTime(),
        );
      });

      it("should reject invalid credential names", async () => {
        await expect(
          setCredential(testUserId, "invalid-name", "value"),
        ).rejects.toThrow(BadRequestError);
      });
    });

    describe("listCredentials", () => {
      it("should list all credentials for user", async () => {
        // Ensure we have at least one credential
        await setCredential(testUserId, "LIST_TEST_KEY", "value");

        const result = await listCredentials(testUserId);

        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);
        expect(result.some((c) => c.name === "LIST_TEST_KEY")).toBe(true);
      });

      it("should return empty array for user without scope", async () => {
        const result = await listCredentials("nonexistent-user-12345");
        expect(result).toEqual([]);
      });

      it("should not return credential values", async () => {
        const result = await listCredentials(testUserId);

        for (const credential of result) {
          expect(credential).not.toHaveProperty("value");
          expect(credential).not.toHaveProperty("encryptedValue");
        }
      });
    });

    describe("getCredential", () => {
      it("should return credential metadata", async () => {
        await setCredential(testUserId, "GET_TEST_KEY", "secret-value");

        const credential = await getCredential(testUserId, "GET_TEST_KEY");

        expect(credential).toBeDefined();
        expect(credential!.name).toBe("GET_TEST_KEY");
        expect(credential).not.toHaveProperty("value");
      });

      it("should return null for nonexistent credential", async () => {
        const credential = await getCredential(
          testUserId,
          "NONEXISTENT_KEY_12345",
        );
        expect(credential).toBeNull();
      });
    });

    describe("getCredentialValue", () => {
      it("should return decrypted credential value", async () => {
        const secretValue = "my-super-secret-value";
        await setCredential(testUserId, "VALUE_TEST_KEY", secretValue);

        const value = await getCredentialValue(testScopeId, "VALUE_TEST_KEY");

        expect(value).toBe(secretValue);
      });

      it("should return null for nonexistent credential", async () => {
        const value = await getCredentialValue(
          testScopeId,
          "NONEXISTENT_KEY_12345",
        );
        expect(value).toBeNull();
      });
    });

    describe("getCredentialValues", () => {
      it("should return all credential values as a map", async () => {
        await setCredential(testUserId, "BATCH_KEY_1", "value1");
        await setCredential(testUserId, "BATCH_KEY_2", "value2");

        const values = await getCredentialValues(testScopeId);

        expect(values.BATCH_KEY_1).toBe("value1");
        expect(values.BATCH_KEY_2).toBe("value2");
      });
    });

    describe("deleteCredential", () => {
      it("should delete credential successfully", async () => {
        await setCredential(testUserId, "DELETE_TEST_KEY", "value");

        await deleteCredential(testUserId, "DELETE_TEST_KEY");

        const credential = await getCredential(testUserId, "DELETE_TEST_KEY");
        expect(credential).toBeNull();
      });

      it("should throw NotFoundError for nonexistent credential", async () => {
        await expect(
          deleteCredential(testUserId, "NONEXISTENT_DELETE_KEY"),
        ).rejects.toThrow(NotFoundError);
      });
    });
  });
});
