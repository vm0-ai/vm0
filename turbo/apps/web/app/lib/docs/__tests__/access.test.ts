import { beforeEach, describe, expect, it, vi } from "vitest";
import { canViewDocs, canViewDocsForUser } from "../access";

const { authMock } = vi.hoisted(() => {
  return {
    authMock: vi.fn(),
  };
});

vi.mock("@clerk/nextjs/server", () => {
  return {
    auth: authMock,
  };
});

describe("docs access", () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it("allows signed-out users through the static docs gate", async () => {
    await expect(canViewDocsForUser(null, null)).resolves.toBe(true);
  });

  it("allows users without an org through the static docs gate", async () => {
    await expect(canViewDocsForUser("user-without-org", null)).resolves.toBe(
      true,
    );
  });

  it("allows org users through the static docs gate", async () => {
    await expect(canViewDocsForUser("user-docs", "org-docs")).resolves.toBe(
      true,
    );
  });

  it("evaluates the current Clerk session", async () => {
    authMock.mockResolvedValue({
      userId: null,
      orgId: null,
    });

    await expect(canViewDocs()).resolves.toBe(true);

    expect(authMock).toHaveBeenCalledTimes(1);
  });
});
