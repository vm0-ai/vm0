import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { creditsMemberList$ } from "../member-credit-caps.ts";
import {
  setMockUsageMembers,
  setMockMemberCreditCap,
  resetMockUsageMembers,
  resetMockMemberCreditCaps,
} from "../../../mocks/handlers/api-usage.ts";
import { zeroMemberCreditCapContract } from "@vm0/core";
import { mockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();

interface CapturedCapCall {
  userId: string;
  creditCap: number | null;
}

interface MockMember {
  userId: string;
  email: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  creditsCharged: number;
  creditCap: number | null;
}

function memberA(): MockMember {
  return {
    userId: "user-a",
    email: "alice@example.com",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    creditsCharged: 500,
    creditCap: null,
  };
}

function memberB(): MockMember {
  return {
    userId: "user-b",
    email: "bob@example.com",
    inputTokens: 200,
    outputTokens: 100,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    creditsCharged: 1200,
    creditCap: null,
  };
}

beforeEach(() => {
  resetMockUsageMembers();
  resetMockMemberCreditCaps();
});

function setupUsageMembers(members: MockMember[]) {
  setMockUsageMembers({
    period: { start: "2026-03-01", end: "2026-03-31" },
    members,
  });
}

function setupCreditCaps(
  caps: Record<string, { creditCap: number | null; creditEnabled: boolean }>,
) {
  for (const [userId, cap] of Object.entries(caps)) {
    setMockMemberCreditCap(userId, cap.creditCap, cap.creditEnabled);
  }
}

function setupCreditCapPut(captured: { calls: CapturedCapCall[] }) {
  server.use(
    mockApi(zeroMemberCreditCapContract.set, ({ body, respond }) => {
      captured.calls.push({ userId: body.userId, creditCap: body.creditCap });
      return respond(200, {
        userId: body.userId,
        creditCap: body.creditCap,
        creditEnabled: body.creditCap !== null,
      });
    }),
  );
}

function setup() {
  detachedSetupPage({ context, path: "/", withoutRender: true });
}

describe("creditsMemberList$", () => {
  it("should return member settings with credit caps from API", async () => {
    setupUsageMembers([memberA(), memberB()]);
    setupCreditCaps({
      "user-a": { creditCap: 1000, creditEnabled: true },
      "user-b": { creditCap: null, creditEnabled: false },
    });

    await setup();

    const members = await context.store.get(creditsMemberList$);
    expect(members).toHaveLength(2);

    expect(members[0].userId).toBe("user-a");
    expect(members[0].email).toBe("alice@example.com");
    expect(members[0].creditsCharged).toBe(500);
    expect(members[0].creditCap).toBe(1000);

    expect(members[1].userId).toBe("user-b");
    expect(members[1].email).toBe("bob@example.com");
    expect(members[1].creditCap).toBeNull();
  });

  it("should throw when API returns non-OK for credit cap fetch", async () => {
    setupUsageMembers([memberA()]);
    // Keep raw http.get for 500 since it's not in the contract's defined responses
    server.use(
      http.get("*/api/zero/org/members/credit-cap", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Internal server error",
              code: "INTERNAL_SERVER_ERROR",
            },
          },
          { status: 500 },
        );
      }),
    );

    await setup();

    await expect(context.store.get(creditsMemberList$)).rejects.toThrow(
      "Internal server error",
    );
  });
});

describe("save$ command", () => {
  it("should call PUT with parsed credit cap and exit edit mode", async () => {
    setupUsageMembers([memberA()]);
    setupCreditCaps({
      "user-a": { creditCap: null, creditEnabled: false },
    });
    const captured: { calls: CapturedCapCall[] } = { calls: [] };
    setupCreditCapPut(captured);

    await setup();

    const members = await context.store.get(creditsMemberList$);
    const member = members[0];

    // Enter edit mode and set a value
    context.store.set(member.enterEditMode$);
    expect(context.store.get(member.editMode$)).toBeTruthy();

    context.store.set(member.setValue$, "2000");
    expect(context.store.get(member.value$)).toBe("2000");

    // Save
    await context.store.set(member.save$, context.signal);

    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]).toStrictEqual({
      userId: "user-a",
      creditCap: 2000,
    });
    expect(context.store.get(member.editMode$)).toBeFalsy();
  });

  it("should not call PUT when value is invalid (non-positive)", async () => {
    setupUsageMembers([memberA()]);
    setupCreditCaps({
      "user-a": { creditCap: null, creditEnabled: false },
    });
    const captured: { calls: CapturedCapCall[] } = { calls: [] };
    setupCreditCapPut(captured);

    await setup();

    const members = await context.store.get(creditsMemberList$);
    const member = members[0];

    context.store.set(member.enterEditMode$);
    context.store.set(member.setValue$, "-5");
    await context.store.set(member.save$, context.signal);

    expect(captured.calls).toHaveLength(0);
  });

  it("should not call PUT when value is NaN", async () => {
    setupUsageMembers([memberA()]);
    setupCreditCaps({
      "user-a": { creditCap: null, creditEnabled: false },
    });
    const captured: { calls: CapturedCapCall[] } = { calls: [] };
    setupCreditCapPut(captured);

    await setup();

    const members = await context.store.get(creditsMemberList$);
    const member = members[0];

    context.store.set(member.enterEditMode$);
    context.store.set(member.setValue$, "abc");
    await context.store.set(member.save$, context.signal);

    expect(captured.calls).toHaveLength(0);
  });

  it("should call PUT with null creditCap when value is empty", async () => {
    setupUsageMembers([memberA()]);
    setupCreditCaps({
      "user-a": { creditCap: 1000, creditEnabled: true },
    });
    const captured: { calls: CapturedCapCall[] } = { calls: [] };
    setupCreditCapPut(captured);

    await setup();

    const members = await context.store.get(creditsMemberList$);
    const member = members[0];

    context.store.set(member.enterEditMode$);
    context.store.set(member.setValue$, "");
    await context.store.set(member.save$, context.signal);

    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]).toStrictEqual({
      userId: "user-a",
      creditCap: null,
    });
  });
});

describe("clearCap$ command", () => {
  it("should call PUT with null creditCap and exit edit mode", async () => {
    setupUsageMembers([memberA()]);
    setupCreditCaps({
      "user-a": { creditCap: 1000, creditEnabled: true },
    });
    const captured: { calls: CapturedCapCall[] } = { calls: [] };
    setupCreditCapPut(captured);

    await setup();

    const members = await context.store.get(creditsMemberList$);
    const member = members[0];

    context.store.set(member.enterEditMode$);
    await context.store.set(member.clearCap$, context.signal);

    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]).toStrictEqual({
      userId: "user-a",
      creditCap: null,
    });
    expect(context.store.get(member.editMode$)).toBeFalsy();
  });
});

describe("edit mode signals", () => {
  it("should toggle edit mode and reset value on enter", async () => {
    setupUsageMembers([memberA()]);
    setupCreditCaps({
      "user-a": { creditCap: 500, creditEnabled: true },
    });

    await setup();

    const members = await context.store.get(creditsMemberList$);
    const member = members[0];

    expect(context.store.get(member.editMode$)).toBeFalsy();

    context.store.set(member.enterEditMode$);
    expect(context.store.get(member.editMode$)).toBeTruthy();
    expect(context.store.get(member.value$)).toBe("500");

    context.store.set(member.exitEditMode$);
    expect(context.store.get(member.editMode$)).toBeFalsy();
  });

  it("should initialize value to empty string when creditCap is null", async () => {
    setupUsageMembers([memberA()]);
    setupCreditCaps({
      "user-a": { creditCap: null, creditEnabled: false },
    });

    await setup();

    const members = await context.store.get(creditsMemberList$);
    const member = members[0];

    context.store.set(member.enterEditMode$);
    expect(context.store.get(member.value$)).toBe("");
  });
});

describe("creditsMemberList$ caching", () => {
  it("should reuse cached setting when creditCap has not changed", async () => {
    setupUsageMembers([memberA()]);
    setupCreditCaps({
      "user-a": { creditCap: 1000, creditEnabled: true },
    });

    await setup();

    const members1 = await context.store.get(creditsMemberList$);
    const setting1 = members1[0];

    // Enter edit mode to create observable state
    context.store.set(setting1.enterEditMode$);
    context.store.set(setting1.setValue$, "9999");

    // Re-evaluate the computed (same underlying data)
    const members2 = await context.store.get(creditsMemberList$);
    const setting2 = members2[0];

    // Should be the same object reference (cached)
    expect(setting2).toBe(setting1);
    // Edit state should be preserved
    expect(context.store.get(setting2.editMode$)).toBeTruthy();
    expect(context.store.get(setting2.value$)).toBe("9999");
  });
});
