import { describe, it, expect } from "vitest";
import type { AuthContext } from "../get-auth-context";
import { userProfileFromClaims } from "../user-profile-from-claims";

function makeCtx(overrides: Partial<AuthContext>): AuthContext {
  return {
    userId: "user_123",
    tokenType: "session",
    sessionClaims: {},
    ...overrides,
  };
}

describe("userProfileFromClaims", () => {
  it("returns { email, name } when all three claims are strings and email non-empty", () => {
    const result = userProfileFromClaims(
      makeCtx({
        sessionClaims: {
          email: "ada@example.com",
          first_name: "Ada",
          last_name: "Lovelace",
        },
      }),
    );
    expect(result).toEqual({ email: "ada@example.com", name: "Ada Lovelace" });
  });

  it("returns undefined when tokenType is not 'session'", () => {
    const claims = {
      email: "ada@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
    };
    for (const tokenType of ["pat", "sandbox", "zero", undefined] as const) {
      expect(
        userProfileFromClaims(makeCtx({ tokenType, sessionClaims: claims })),
      ).toBeUndefined();
    }
  });

  it("returns undefined when sessionClaims is undefined", () => {
    expect(
      userProfileFromClaims(makeCtx({ sessionClaims: undefined })),
    ).toBeUndefined();
  });

  it("returns undefined when email is empty, absent, or wrong type", () => {
    expect(
      userProfileFromClaims(makeCtx({ sessionClaims: { email: "" } })),
    ).toBeUndefined();
    expect(
      userProfileFromClaims(makeCtx({ sessionClaims: {} })),
    ).toBeUndefined();
    expect(
      userProfileFromClaims(
        makeCtx({ sessionClaims: { email: 42 as unknown as string } }),
      ),
    ).toBeUndefined();
  });

  it("returns { email, name: null } when both first_name and last_name are absent", () => {
    expect(
      userProfileFromClaims(
        makeCtx({ sessionClaims: { email: "ada@example.com" } }),
      ),
    ).toEqual({ email: "ada@example.com", name: null });
  });

  it("returns { email, name: 'Ada' } when only first_name is set", () => {
    expect(
      userProfileFromClaims(
        makeCtx({
          sessionClaims: { email: "ada@example.com", first_name: "Ada" },
        }),
      ),
    ).toEqual({ email: "ada@example.com", name: "Ada" });
  });

  it("returns { email, name: 'Lovelace' } when only last_name is set", () => {
    expect(
      userProfileFromClaims(
        makeCtx({
          sessionClaims: { email: "ada@example.com", last_name: "Lovelace" },
        }),
      ),
    ).toEqual({ email: "ada@example.com", name: "Lovelace" });
  });

  it("ignores non-string first_name / last_name (defensive type-narrowing)", () => {
    expect(
      userProfileFromClaims(
        makeCtx({
          sessionClaims: {
            email: "ada@example.com",
            first_name: 123 as unknown as string,
            last_name: null as unknown as string,
          },
        }),
      ),
    ).toEqual({ email: "ada@example.com", name: null });
  });
});
