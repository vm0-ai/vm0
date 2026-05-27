import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { canViewDocs, createCanViewDocsForUser } from "../access";

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
  const loadFeatureSwitchOverridesMock = vi.fn();

  beforeEach(() => {
    authMock.mockReset();
    loadFeatureSwitchOverridesMock.mockReset();
  });

  it("allows signed-out users without querying feature switch overrides", async () => {
    const canViewDocsForUser = createCanViewDocsForUser(
      loadFeatureSwitchOverridesMock,
    );

    await expect(canViewDocsForUser(null, null)).resolves.toBe(true);

    expect(loadFeatureSwitchOverridesMock).not.toHaveBeenCalled();
  });

  it("allows users without an org without querying feature switch overrides", async () => {
    const canViewDocsForUser = createCanViewDocsForUser(
      loadFeatureSwitchOverridesMock,
    );

    await expect(canViewDocsForUser("user-without-org", null)).resolves.toBe(
      true,
    );

    expect(loadFeatureSwitchOverridesMock).not.toHaveBeenCalled();
  });

  it("allows docs when the per-user docsSite override is enabled", async () => {
    loadFeatureSwitchOverridesMock.mockResolvedValue({
      [FeatureSwitchKey.DocsSite]: true,
    });
    const canViewDocsForUser = createCanViewDocsForUser(
      loadFeatureSwitchOverridesMock,
    );

    await expect(canViewDocsForUser("user-docs-on", "org-docs")).resolves.toBe(
      true,
    );

    expect(loadFeatureSwitchOverridesMock).toHaveBeenCalledWith(
      "org-docs",
      "user-docs-on",
    );
  });

  it("falls back to the static gate when override loading fails", async () => {
    loadFeatureSwitchOverridesMock.mockRejectedValue(new Error("db down"));
    const canViewDocsForUser = createCanViewDocsForUser(
      loadFeatureSwitchOverridesMock,
    );

    await expect(
      canViewDocsForUser("user-docs-fallback", "org-docs-fallback"),
    ).resolves.toBe(true);
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
