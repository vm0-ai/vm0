import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { canViewDocs, canViewDocsForUser } from "../access";

const { authMock, loadFeatureSwitchOverridesMock } = vi.hoisted(() => {
  return {
    authMock: vi.fn(),
    loadFeatureSwitchOverridesMock: vi.fn(),
  };
});

vi.mock("@clerk/nextjs/server", () => {
  return {
    auth: authMock,
  };
});

vi.mock("../../../../src/lib/zero/user/feature-switches-service", () => {
  return {
    loadFeatureSwitchOverrides: loadFeatureSwitchOverridesMock,
  };
});

describe("docs access", () => {
  beforeEach(() => {
    authMock.mockReset();
    loadFeatureSwitchOverridesMock.mockReset();
  });

  it("does not query feature switch overrides for signed-out users", async () => {
    await expect(canViewDocsForUser(null, null)).resolves.toBe(false);

    expect(loadFeatureSwitchOverridesMock).not.toHaveBeenCalled();
  });

  it("allows docs when the per-user docsSite override is enabled", async () => {
    loadFeatureSwitchOverridesMock.mockResolvedValue({
      [FeatureSwitchKey.DocsSite]: true,
    });

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

    await expect(
      canViewDocsForUser("user-docs-fallback", "org-docs-fallback"),
    ).resolves.toBe(false);
  });

  it("evaluates the current Clerk session", async () => {
    authMock.mockResolvedValue({
      userId: "user-docs-session",
      orgId: "org-docs-session",
    });
    loadFeatureSwitchOverridesMock.mockResolvedValue({
      [FeatureSwitchKey.DocsSite]: true,
    });

    await expect(canViewDocs()).resolves.toBe(true);

    expect(authMock).toHaveBeenCalledTimes(1);
    expect(loadFeatureSwitchOverridesMock).toHaveBeenCalledWith(
      "org-docs-session",
      "user-docs-session",
    );
  });
});
