import { describe, it, expect, beforeEach } from "vitest";
import {
  testContext,
  uniqueId,
  uniqueNumericId,
} from "../../../../__tests__/test-helpers";
import { linkIMessageUserToVm0User, resolveIMessageUserLink } from "../shared";
import { initServices } from "../../../../lib/init-services";

const context = testContext();

function uniquePhone(): string {
  return `+1555${uniqueNumericId().slice(0, 7)}`;
}

describe("iMessage user link binding semantics", () => {
  beforeEach(() => {
    context.setupMocks();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: link helper is the DB-backed unit under test
    initServices();
  });

  it("allows one phone handle to bind to exactly one active user and org", async () => {
    const phoneHandle = uniquePhone();
    const first = await linkIMessageUserToVm0User({
      phoneHandle,
      vm0UserId: uniqueId("user"),
      orgId: uniqueId("org"),
    });

    expect(first.ok).toBe(true);

    const second = await linkIMessageUserToVm0User({
      phoneHandle,
      vm0UserId: uniqueId("user"),
      orgId: uniqueId("org"),
    });

    expect(second).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "phone-handle-linked",
      }),
    );
  });

  it("allows one user and org to bind to exactly one active phone handle", async () => {
    const vm0UserId = uniqueId("user");
    const orgId = uniqueId("org");
    const first = await linkIMessageUserToVm0User({
      phoneHandle: uniquePhone(),
      vm0UserId,
      orgId,
    });

    expect(first.ok).toBe(true);

    const second = await linkIMessageUserToVm0User({
      phoneHandle: uniquePhone(),
      vm0UserId,
      orgId,
    });

    expect(second).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "vm0-org-linked",
      }),
    );
  });

  it("normalizes phone handles before resolving links", async () => {
    const vm0UserId = uniqueId("user");
    const orgId = uniqueId("org");
    const suffix = uniqueNumericId().slice(0, 4);
    const phoneHandle = `(555) 555-${suffix}`;
    const normalizedPhoneHandle = `555555${suffix}`;
    await linkIMessageUserToVm0User({
      phoneHandle,
      vm0UserId,
      orgId,
    });

    await expect(
      resolveIMessageUserLink(normalizedPhoneHandle),
    ).resolves.toEqual(
      expect.objectContaining({
        phoneHandle: normalizedPhoneHandle,
        vm0UserId,
        orgId,
      }),
    );
  });
});
