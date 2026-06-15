import { randomUUID } from "node:crypto";

import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { emailSuppressions } from "@vm0/db/schema/email-suppression";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { userCache } from "@vm0/db/schema/user-cache";
import { users } from "@vm0/db/schema/user";
import { createStore } from "ccstate";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createFixtureTracker } from "../../routes/__tests__/helpers/zero-route-test";
import { writeDb$ } from "../../external/db";
import { nowDate } from "../../external/time";
import { LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS } from "../zero-credit-low-balance-alert.service";
import { processOrgUsageEvents$ } from "../zero-credit-usage.service";

const context = testContext();
const store = createStore();

const TEST_KIND = "connector";
const TEST_CATEGORY = "credit-low-balance-test";

interface MemberFixture {
  readonly userId: string;
  readonly email: string;
  readonly role: "org:admin" | "org:member";
  readonly emailUnsubscribed?: boolean;
}

interface UsageFixture {
  readonly orgId: string;
  readonly orgName: string;
  readonly provider: string;
  readonly billingUserId: string;
  readonly members: readonly MemberFixture[];
}

interface AlertRow {
  readonly toAddresses: unknown;
  readonly template: unknown;
  readonly headers: unknown;
  readonly status: string;
  readonly subject: string;
}

interface CreditLowBalanceTemplate {
  readonly template: "credit-low-balance";
  readonly props: {
    readonly orgName: string;
    readonly remainingCredits: number;
    readonly thresholdCredits: number;
    readonly billingUrl: string;
    readonly unsubscribeUrl?: string;
  };
}

function uniqueId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function member(role: MemberFixture["role"], email?: string): MemberFixture {
  const id = uniqueId();
  return {
    userId: `user_credit_alert_${id}`,
    email: email ?? `credit-alert-${id}@example.com`,
    role,
  };
}

function uniqueMembersByUserId(
  members: readonly MemberFixture[],
): MemberFixture[] {
  return [
    ...new Map(
      members.map((entry) => {
        return [entry.userId, entry];
      }),
    ).values(),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAddresses(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (
    Array.isArray(value) &&
    value.every((entry): entry is string => {
      return typeof entry === "string";
    })
  ) {
    return value;
  }
  throw new Error("Expected email address JSON to be a string or string array");
}

function parseLowCreditTemplate(value: unknown): CreditLowBalanceTemplate {
  if (
    isRecord(value) &&
    value.template === "credit-low-balance" &&
    isRecord(value.props) &&
    typeof value.props.orgName === "string" &&
    typeof value.props.remainingCredits === "number" &&
    typeof value.props.thresholdCredits === "number" &&
    typeof value.props.billingUrl === "string" &&
    (value.props.unsubscribeUrl === undefined ||
      typeof value.props.unsubscribeUrl === "string")
  ) {
    return {
      template: value.template,
      props: {
        orgName: value.props.orgName,
        remainingCredits: value.props.remainingCredits,
        thresholdCredits: value.props.thresholdCredits,
        billingUrl: value.props.billingUrl,
        unsubscribeUrl: value.props.unsubscribeUrl,
      },
    };
  }
  throw new Error("Expected credit low-balance email template");
}

function parseHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error("Expected email headers JSON to be an object");
  }

  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error("Expected email header values to be strings");
    }
    headers[key] = entry;
  }
  return headers;
}

function mockCurrentOrgMembers(
  orgId: string,
  members: readonly MemberFixture[],
): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (args: unknown) => {
      const input = isRecord(args) ? args : {};
      const organizationId =
        typeof input.organizationId === "string" ? input.organizationId : "";
      const offset = typeof input.offset === "number" ? input.offset : 0;
      const limit = typeof input.limit === "number" ? input.limit : 100;
      const pageMembers = organizationId === orgId ? members : [];

      return Promise.resolve({
        data: pageMembers.slice(offset, offset + limit).map((entry) => {
          return {
            role: entry.role,
            publicUserData: { userId: entry.userId },
          };
        }),
      });
    },
  );
}

async function addUsageEvent(
  fixture: UsageFixture,
  chargeCredits: number,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(usageEvent).values({
    idempotencyKey: randomUUID(),
    orgId: fixture.orgId,
    userId: fixture.billingUserId,
    kind: TEST_KIND,
    provider: fixture.provider,
    category: TEST_CATEGORY,
    quantity: chargeCredits,
  });
}

async function seedUsageFixture(options: {
  readonly beforeCredits: number;
  readonly chargeCredits: number;
  readonly members?: readonly MemberFixture[];
  readonly expiredCredits?: number;
  readonly suppressEmails?: readonly string[];
}): Promise<UsageFixture> {
  const db = store.set(writeDb$);
  const id = uniqueId();
  const members = options.members ?? [member("org:admin")];
  const fixture: UsageFixture = {
    orgId: `org_credit_alert_${id}`,
    orgName: `Credit Alert Org ${id}`,
    provider: `credit-alert-${id}`,
    billingUserId: members[0]?.userId ?? `user_credit_alert_billing_${id}`,
    members,
  };

  await db
    .insert(orgMetadata)
    .values({
      orgId: fixture.orgId,
      credits: options.beforeCredits,
      tier: "free",
      autoRechargeEnabled: false,
    })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: {
        credits: options.beforeCredits,
        tier: "free",
        autoRechargeEnabled: false,
        updatedAt: nowDate(),
      },
    });

  await db
    .insert(orgCache)
    .values({
      orgId: fixture.orgId,
      slug: `credit-alert-${id}`,
      name: fixture.orgName,
      cachedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: {
        slug: `credit-alert-${id}`,
        name: fixture.orgName,
        cachedAt: nowDate(),
      },
    });

  const uniqueMembers = uniqueMembersByUserId(members);
  if (uniqueMembers.length > 0) {
    await db
      .insert(users)
      .values(
        uniqueMembers.map((entry) => {
          return {
            id: entry.userId,
            emailUnsubscribed: entry.emailUnsubscribed ?? false,
          };
        }),
      )
      .onConflictDoUpdate({
        target: users.id,
        set: {
          emailUnsubscribed: sql`excluded.email_unsubscribed`,
          updatedAt: nowDate(),
        },
      });

    await db
      .insert(userCache)
      .values(
        uniqueMembers.map((entry) => {
          return {
            userId: entry.userId,
            email: entry.email,
            name: "Credit Alert Recipient",
            cachedAt: nowDate(),
          };
        }),
      )
      .onConflictDoUpdate({
        target: userCache.userId,
        set: {
          email: sql`excluded.email`,
          name: sql`excluded.name`,
          cachedAt: sql`excluded.cached_at`,
        },
      });
  }

  await db
    .insert(usagePricing)
    .values({
      kind: TEST_KIND,
      provider: fixture.provider,
      category: TEST_CATEGORY,
      unitPrice: 1,
      unitSize: 1,
    })
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: 1,
        unitSize: 1,
        updatedAt: nowDate(),
      },
    });

  if (options.expiredCredits) {
    await db.insert(creditExpiresRecord).values({
      orgId: fixture.orgId,
      source: "subscription_renewal",
      amount: options.expiredCredits,
      remaining: options.expiredCredits,
      expiresAt: new Date(nowDate().getTime() - 1000),
    });
  }

  const suppressEmails = options.suppressEmails ?? [];
  if (suppressEmails.length > 0) {
    await db.insert(emailSuppressions).values(
      suppressEmails.map((email) => {
        return {
          emailAddress: email,
          reason: "bounced",
        };
      }),
    );
  }

  await addUsageEvent(fixture, options.chargeCredits);
  mockCurrentOrgMembers(fixture.orgId, members);
  return fixture;
}

async function cleanupFixture(fixture: UsageFixture): Promise<void> {
  const db = store.set(writeDb$);
  const userIds = fixture.members.map((entry) => {
    return entry.userId;
  });
  const emails = fixture.members.map((entry) => {
    return entry.email.toLowerCase();
  });

  await db
    .delete(emailOutbox)
    .where(
      sql`${emailOutbox.template}->'props'->>'orgName' = ${fixture.orgName}`,
    );
  if (emails.length > 0) {
    await db.delete(emailSuppressions).where(
      sql`lower(${emailSuppressions.emailAddress}) IN (${sql.join(
        emails.map((email) => {
          return sql`${email}`;
        }),
        sql`, `,
      )})`,
    );
  }
  await db
    .delete(creditExpiresRecord)
    .where(eq(creditExpiresRecord.orgId, fixture.orgId));
  await db.delete(usageEvent).where(eq(usageEvent.orgId, fixture.orgId));
  await db
    .delete(usagePricing)
    .where(eq(usagePricing.provider, fixture.provider));
  await db
    .delete(orgMembersCache)
    .where(eq(orgMembersCache.orgId, fixture.orgId));
  await db.delete(orgCache).where(eq(orgCache.orgId, fixture.orgId));
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  if (userIds.length > 0) {
    await db.delete(userCache).where(inArray(userCache.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
}

async function lowCreditAlerts(fixture: UsageFixture): Promise<AlertRow[]> {
  const db = store.set(writeDb$);
  return await db
    .select({
      toAddresses: emailOutbox.toAddresses,
      template: emailOutbox.template,
      headers: emailOutbox.headers,
      status: emailOutbox.status,
      subject: emailOutbox.subject,
    })
    .from(emailOutbox)
    .where(
      sql`${emailOutbox.template}->'props'->>'orgName' = ${fixture.orgName}`,
    )
    .orderBy(asc(emailOutbox.createdAt));
}

async function orgCredits(orgId: string): Promise<number> {
  const db = store.set(writeDb$);
  const [metadata] = await db
    .select({ credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return metadata?.credits ?? 0;
}

async function processFixture(fixture: UsageFixture): Promise<void> {
  await store.set(processOrgUsageEvents$, fixture.orgId, context.signal);
}

const trackFixture = createFixtureTracker<UsageFixture>((fixture) => {
  return cleanupFixture(fixture);
});

async function createUsageFixture(
  options: Parameters<typeof seedUsageFixture>[0],
): Promise<UsageFixture> {
  return await trackFixture(seedUsageFixture(options));
}

beforeEach(() => {
  mockEnv("APP_URL", "https://app.vm0.test");
  mockEnv("VM0_API_URL", "https://api.vm0.test");
  mockEnv("RESEND_FROM_DOMAIN", "mail.vm0.test");
  mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
});

describe("processOrgUsageEvents$ low-credit alerts", () => {
  it("enqueues a low-credit alert when usage crosses the threshold", async () => {
    mockEnv("APP_URL", "https://app.vm0.test/");
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS + 1000,
      chargeCredits: 1500,
    });

    await processFixture(fixture);

    const alerts = await lowCreditAlerts(fixture);
    const admin = fixture.members[0];
    if (!admin) {
      throw new Error("Expected fixture admin");
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.status).toBe("pending");
    expect(alerts[0]?.subject).toBe("Your credit balance is running low");
    expect(parseAddresses(alerts[0]?.toAddresses)).toStrictEqual([admin.email]);
    const template = parseLowCreditTemplate(alerts[0]?.template);
    expect(template).toMatchObject({
      template: "credit-low-balance",
      props: {
        orgName: fixture.orgName,
        remainingCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS - 500,
        thresholdCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS,
        billingUrl:
          "https://app.vm0.test/?settings=billing&billingView=credits",
      },
    });
    expect(template.props.unsubscribeUrl).toContain(
      `https://api.vm0.test/api/email/unsubscribe?token=${admin.userId}.`,
    );
    const headers = parseHeaders(alerts[0]?.headers);
    expect(headers["List-Unsubscribe"]).toBe(
      `<${template.props.unsubscribeUrl}>`,
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    const db = store.set(writeDb$);
    const [cachedAdmin] = await db
      .select({ role: orgMembersCache.role })
      .from(orgMembersCache)
      .where(eq(orgMembersCache.orgId, fixture.orgId))
      .limit(1);
    expect(cachedAdmin?.role).toBe("admin");
  });

  it("does not alert when usage leaves credits above the threshold", async () => {
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS + 3000,
      chargeCredits: 1000,
    });

    await processFixture(fixture);

    await expect(orgCredits(fixture.orgId)).resolves.toBe(
      LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS + 2000,
    );
    await expect(lowCreditAlerts(fixture)).resolves.toStrictEqual([]);
  });

  it("does not alert when credits were already below the threshold", async () => {
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS - 1000,
      chargeCredits: 100,
    });

    await processFixture(fixture);

    await expect(orgCredits(fixture.orgId)).resolves.toBe(
      LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS - 1100,
    );
    await expect(lowCreditAlerts(fixture)).resolves.toStrictEqual([]);
  });

  it("does not alert when credits start exactly at the threshold", async () => {
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS,
      chargeCredits: 1,
    });

    await processFixture(fixture);

    await expect(lowCreditAlerts(fixture)).resolves.toStrictEqual([]);
  });

  it("alerts when usage lands exactly on the threshold from above", async () => {
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS + 1,
      chargeCredits: 1,
    });

    await processFixture(fixture);

    const alerts = await lowCreditAlerts(fixture);
    expect(alerts).toHaveLength(1);
    expect(
      parseLowCreditTemplate(alerts[0]?.template).props.remainingCredits,
    ).toBe(LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS);
  });

  it("alerts again after credits are topped up and cross the threshold again", async () => {
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS + 1000,
      chargeCredits: 1200,
    });

    await processFixture(fixture);

    const db = store.set(writeDb$);
    await db
      .update(orgMetadata)
      .set({
        credits: sql`${orgMetadata.credits} + 2000`,
        updatedAt: nowDate(),
      })
      .where(eq(orgMetadata.orgId, fixture.orgId));
    await addUsageEvent(fixture, 1900);

    await processFixture(fixture);

    const alerts = await lowCreditAlerts(fixture);
    expect(alerts).toHaveLength(2);
    expect(
      parseLowCreditTemplate(alerts[1]?.template).props.remainingCredits,
    ).toBe(LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS - 100);
  });

  it("sends to current admin emails, deduped case-insensitively", async () => {
    const firstAdmin = member("org:admin", "Admin@example.com");
    const duplicateAdmin = member("org:admin", "admin@example.com");
    const secondAdmin = member("org:admin", "billing-admin@example.com");
    const nonAdmin = member("org:member", "member@example.com");
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS + 600,
      chargeCredits: 700,
      members: [firstAdmin, duplicateAdmin, secondAdmin, nonAdmin],
    });

    await processFixture(fixture);

    const alerts = await lowCreditAlerts(fixture);
    expect(alerts).toHaveLength(2);
    const recipients = alerts
      .flatMap((alert) => {
        return parseAddresses(alert.toAddresses);
      })
      .sort();
    expect(recipients).toStrictEqual(
      [firstAdmin.email, secondAdmin.email].sort(),
    );
    for (const alert of alerts) {
      expect(parseAddresses(alert.toAddresses)).toHaveLength(1);
    }
  });

  it("keeps admin in the member cache when duplicate membership rows disagree", async () => {
    const admin = member("org:admin", "duplicate-role-admin@example.com");
    const duplicateMember = {
      ...admin,
      role: "org:member" as const,
    };
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS + 600,
      chargeCredits: 700,
      members: [admin, duplicateMember],
    });

    await processFixture(fixture);

    const alerts = await lowCreditAlerts(fixture);
    expect(alerts).toHaveLength(1);
    expect(parseAddresses(alerts[0]?.toAddresses)).toStrictEqual([admin.email]);

    const db = store.set(writeDb$);
    const [cachedMember] = await db
      .select({ role: orgMembersCache.role })
      .from(orgMembersCache)
      .where(eq(orgMembersCache.orgId, fixture.orgId))
      .limit(1);
    expect(cachedMember?.role).toBe("admin");
  });

  it("pages current org memberships before selecting admin recipients", async () => {
    const pagedAdmin = member("org:admin", "paged-admin@example.com");
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS + 600,
      chargeCredits: 700,
      members: [
        ...Array.from({ length: 100 }, () => {
          return member("org:member");
        }),
        pagedAdmin,
      ],
    });

    await processFixture(fixture);

    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledWith({
      organizationId: fixture.orgId,
      limit: 100,
      offset: 100,
    });
    const alerts = await lowCreditAlerts(fixture);
    expect(alerts).toHaveLength(1);
    expect(parseAddresses(alerts[0]?.toAddresses)).toStrictEqual([
      pagedAdmin.email,
    ]);
  });

  it("does not enqueue an alert when the org has no current admin", async () => {
    const currentMember = member("org:member");
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS + 600,
      chargeCredits: 700,
      members: [currentMember],
    });
    const db = store.set(writeDb$);
    await db.insert(orgMembersCache).values({
      orgId: fixture.orgId,
      userId: `user_stale_admin_${uniqueId()}`,
      role: "admin",
      cachedAt: nowDate(),
    });

    await processFixture(fixture);

    await expect(orgCredits(fixture.orgId)).resolves.toBe(
      LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS - 100,
    );
    await expect(lowCreditAlerts(fixture)).resolves.toStrictEqual([]);
    await expect(
      db
        .select({ userId: orgMembersCache.userId, role: orgMembersCache.role })
        .from(orgMembersCache)
        .where(eq(orgMembersCache.orgId, fixture.orgId)),
    ).resolves.toStrictEqual([
      { userId: currentMember.userId, role: "member" },
    ]);
  });

  it("does not roll back usage when alert recipient lookup fails", async () => {
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS + 600,
      chargeCredits: 700,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValueOnce(
      new Error("Clerk unavailable"),
    );

    await expect(processFixture(fixture)).resolves.toBeUndefined();

    await expect(orgCredits(fixture.orgId)).resolves.toBe(
      LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS - 100,
    );
    await expect(lowCreditAlerts(fixture)).resolves.toStrictEqual([]);
  });

  it("does not enqueue an alert when the only current admin is unsubscribed", async () => {
    const admin = {
      ...member("org:admin"),
      emailUnsubscribed: true,
    };
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS + 600,
      chargeCredits: 700,
      members: [admin],
    });

    await processFixture(fixture);

    await expect(lowCreditAlerts(fixture)).resolves.toStrictEqual([]);
  });

  it("filters suppressed admin emails without dropping other admin recipients", async () => {
    const suppressedAdmin = member(
      "org:admin",
      `suppressed-${uniqueId()}@example.com`,
    );
    const activeAdmin = member("org:admin", "active-admin@example.com");
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS + 600,
      chargeCredits: 700,
      members: [suppressedAdmin, activeAdmin],
      suppressEmails: [suppressedAdmin.email.toUpperCase()],
    });

    await processFixture(fixture);

    const alerts = await lowCreditAlerts(fixture);
    expect(alerts).toHaveLength(1);
    expect(parseAddresses(alerts[0]?.toAddresses)).toStrictEqual([
      activeAdmin.email,
    ]);
  });

  it("does not alert when expired credits move the effective starting balance below the threshold", async () => {
    const fixture = await createUsageFixture({
      beforeCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS + 1000,
      chargeCredits: 500,
      expiredCredits: 2000,
    });

    await processFixture(fixture);

    await expect(orgCredits(fixture.orgId)).resolves.toBe(
      LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS - 1500,
    );
    await expect(lowCreditAlerts(fixture)).resolves.toStrictEqual([]);
  });
});

describe("processOrgUsageEvents$ usage underbilling signals", () => {
  it("logs alertable underbilling fields when pricing is missing", async () => {
    const fixture = await createUsageFixture({
      beforeCredits: 1_000_000,
      chargeCredits: 25,
    });
    const db = store.set(writeDb$);
    await db
      .delete(usagePricing)
      .where(eq(usagePricing.provider, fixture.provider));

    await processFixture(fixture);

    const [record] = await db
      .select({
        creditsCharged: usageEvent.creditsCharged,
        billingError: usageEvent.billingError,
        status: usageEvent.status,
      })
      .from(usageEvent)
      .where(eq(usageEvent.orgId, fixture.orgId))
      .limit(1);
    expect(record).toMatchObject({
      creditsCharged: 0,
      billingError: "missing_pricing",
      status: "processed",
    });
  });

  it("logs alertable underbilling fields when fallback pricing is used", async () => {
    const fixture = await createUsageFixture({
      beforeCredits: 1_000_000,
      chargeCredits: 7,
    });
    const db = store.set(writeDb$);
    await db
      .delete(usagePricing)
      .where(eq(usagePricing.provider, fixture.provider));
    await db.insert(usagePricing).values({
      kind: TEST_KIND,
      provider: fixture.provider,
      category: "__fallback__",
      unitPrice: 2,
      unitSize: 1,
    });

    await processFixture(fixture);

    const [record] = await db
      .select({
        creditsCharged: usageEvent.creditsCharged,
        billingError: usageEvent.billingError,
        status: usageEvent.status,
      })
      .from(usageEvent)
      .where(eq(usageEvent.orgId, fixture.orgId))
      .limit(1);
    expect(record).toMatchObject({
      creditsCharged: 14,
      billingError: "fallback_pricing",
      status: "processed",
    });
  });
});
