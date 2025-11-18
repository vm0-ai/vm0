/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { authenticate } from "../auth";
import { UnauthorizedError } from "../../errors";
import { createHash } from "crypto";
import { initServices } from "../../init-services";
import { apiKeys } from "../../../db/schema/api-key";
import { eq } from "drizzle-orm";

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

describe("authenticate - integration tests", () => {
  beforeEach(async () => {
    // Initialize services to connect to real database
    initServices();

    // Clean up test data
    await globalThis.services.db
      .delete(apiKeys)
      .where(eq(apiKeys.name, "Test Key"))
      .execute();
    await globalThis.services.db
      .delete(apiKeys)
      .where(eq(apiKeys.name, "Test Key 2"))
      .execute();
  });

  afterEach(async () => {
    // Clean up test data after each test
    await globalThis.services.db
      .delete(apiKeys)
      .where(eq(apiKeys.name, "Test Key"))
      .execute();
    await globalThis.services.db
      .delete(apiKeys)
      .where(eq(apiKeys.name, "Test Key 2"))
      .execute();
  });

  it("should throw UnauthorizedError when API key is missing", async () => {
    const request = new NextRequest("http://localhost/api/test");

    await expect(authenticate(request)).rejects.toThrow(UnauthorizedError);
    await expect(authenticate(request)).rejects.toThrow("Missing API key");
  });

  it("should throw UnauthorizedError when API key is invalid", async () => {
    const request = new NextRequest("http://localhost/api/test", {
      headers: { "x-api-key": "invalid-key" },
    });

    await expect(authenticate(request)).rejects.toThrow(UnauthorizedError);
    await expect(authenticate(request)).rejects.toThrow("Invalid API key");
  });

  it("should return API key ID when authentication succeeds", async () => {
    const apiKey = "valid-key-123";

    // Insert test API key into database
    const [insertedKey] = await globalThis.services.db
      .insert(apiKeys)
      .values({
        keyHash: hashApiKey(apiKey),
        name: "Test Key",
      })
      .returning({ id: apiKeys.id });

    const request = new NextRequest("http://localhost/api/test", {
      headers: { "x-api-key": apiKey },
    });

    const result = await authenticate(request);

    expect(result).toBe(insertedKey?.id);

    // Verify lastUsedAt was updated
    const [updatedKey] = await globalThis.services.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, result))
      .limit(1);

    expect(updatedKey?.lastUsedAt).toBeDefined();
  });

  it("should update lastUsedAt timestamp on successful authentication", async () => {
    const apiKey = "valid-key-456";

    // Insert test API key into database
    const [insertedKey] = await globalThis.services.db
      .insert(apiKeys)
      .values({
        keyHash: hashApiKey(apiKey),
        name: "Test Key 2",
      })
      .returning({ id: apiKeys.id });

    const request = new NextRequest("http://localhost/api/test", {
      headers: { "x-api-key": apiKey },
    });

    // First authentication
    await authenticate(request);

    const [firstCheck] = await globalThis.services.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, insertedKey?.id ?? ""))
      .limit(1);

    const firstLastUsedAt = firstCheck?.lastUsedAt;
    expect(firstLastUsedAt).toBeDefined();

    // Wait a bit and authenticate again
    await new Promise((resolve) => setTimeout(resolve, 100));

    await authenticate(request);

    const [secondCheck] = await globalThis.services.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, insertedKey?.id ?? ""))
      .limit(1);

    const secondLastUsedAt = secondCheck?.lastUsedAt;
    expect(secondLastUsedAt).toBeDefined();
    expect(secondLastUsedAt?.getTime()).toBeGreaterThan(
      firstLastUsedAt?.getTime() ?? 0,
    );
  });
});
