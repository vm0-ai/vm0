import { describe, expect, it } from "vitest";
import { users } from "../schema/user";
import { getTableName } from "drizzle-orm";

describe("Database Schema", () => {
  it("should have users table defined", () => {
    expect(users).toBeDefined();
    expect(getTableName(users)).toBe("users");
  });

  it("should have correct user table columns", () => {
    expect(users.id).toBeDefined();
    expect(users.createdAt).toBeDefined();
    expect(users.updatedAt).toBeDefined();
  });
});
