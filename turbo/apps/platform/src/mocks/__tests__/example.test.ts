import { describe, it, expect } from "vitest";
import type { User, ApiError } from "../handlers/example.ts";

describe("msw example handlers", () => {
  it("should return list of users", async () => {
    const response = await fetch("/api/users");
    const users = (await response.json()) as User[];

    expect(response.ok).toBeTruthy();
    expect(users).toHaveLength(2);
    expect(users[0]?.name).toBe("Alice");
    expect(users[1]?.name).toBe("Bob");
  });

  it("should return a specific user by ID", async () => {
    const response = await fetch("/api/users/1");
    const user = (await response.json()) as User;

    expect(response.ok).toBeTruthy();
    expect(user.id).toBe("1");
    expect(user.name).toBe("Alice");
    expect(user.email).toBe("alice@example.com");
  });

  it("should return 404 for non-existent user", async () => {
    const response = await fetch("/api/users/999");
    const error = (await response.json()) as ApiError;

    expect(response.ok).toBeFalsy();
    expect(response.status).toBe(404);
    expect(error.error).toBe("not_found");
  });

  it("should create a new user", async () => {
    const response = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Charlie", email: "charlie@example.com" }),
    });
    const user = (await response.json()) as User;

    expect(response.status).toBe(201);
    expect(user.name).toBe("Charlie");
    expect(user.email).toBe("charlie@example.com");
  });
});
