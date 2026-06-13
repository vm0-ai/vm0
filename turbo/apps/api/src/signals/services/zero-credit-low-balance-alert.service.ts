import type { createClerkClient } from "@clerk/backend";
import { command } from "ccstate";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { emailSuppressions } from "@vm0/db/schema/email-suppression";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { users } from "@vm0/db/schema/user";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { clerk$ } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import {
  buildFromAddress,
  buildUnsubscribeHeaders,
  buildUnsubscribeUrl,
  getUserEmail,
  type EmailTemplate,
} from "./zero-email-common.service";

type ClerkClient = ReturnType<typeof createClerkClient>;
type OrganizationMembership = Awaited<
  ReturnType<ClerkClient["organizations"]["getOrganizationMembershipList"]>
>["data"][number];

export const LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS = 5000;

const L = logger("CreditLowBalanceAlert");
const ORG_MEMBERSHIP_PAGE_SIZE = 100;

export interface CreditLowBalanceAlertArgs {
  readonly orgId: string;
  readonly remainingCredits: number;
  readonly thresholdCredits: number;
}

interface Recipient {
  readonly userId: string;
  readonly email: string;
}

async function listCurrentOrgMemberships(
  clerk: ClerkClient,
  orgId: string,
  signal: AbortSignal,
): Promise<OrganizationMembership[]> {
  const memberships: OrganizationMembership[] = [];
  for (let offset = 0; ; offset += ORG_MEMBERSHIP_PAGE_SIZE) {
    const page = await clerk.organizations.getOrganizationMembershipList({
      organizationId: orgId,
      limit: ORG_MEMBERSHIP_PAGE_SIZE,
      offset,
    });
    signal.throwIfAborted();
    memberships.push(...page.data);
    if (page.data.length < ORG_MEMBERSHIP_PAGE_SIZE) {
      return memberships;
    }
  }
}

function membershipUserId(
  membership: OrganizationMembership,
): string | undefined {
  return membership.publicUserData?.userId;
}

async function refreshOrgMemberCache(
  db: Db,
  orgId: string,
  memberships: readonly OrganizationMembership[],
): Promise<void> {
  const rows = memberships.flatMap((membership) => {
    const userId = membershipUserId(membership);
    if (!userId) {
      return [];
    }
    return [
      {
        orgId,
        userId,
        role: membership.role === "org:admin" ? "admin" : "member",
        cachedAt: nowDate(),
      },
    ];
  });

  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx
        .insert(orgMembersCache)
        .values(rows)
        .onConflictDoUpdate({
          target: [orgMembersCache.orgId, orgMembersCache.userId],
          set: {
            role: sql`excluded.role`,
            cachedAt: sql`excluded.cached_at`,
          },
        });

      await tx.delete(orgMembersCache).where(
        and(
          eq(orgMembersCache.orgId, orgId),
          notInArray(
            orgMembersCache.userId,
            rows.map((row) => {
              return row.userId;
            }),
          ),
        ),
      );
      return;
    }

    await tx.delete(orgMembersCache).where(eq(orgMembersCache.orgId, orgId));
  });
}

function adminUserIds(
  memberships: readonly OrganizationMembership[],
): string[] {
  return [
    ...new Set(
      memberships.flatMap((membership) => {
        if (membership.role !== "org:admin") {
          return [];
        }
        const userId = membershipUserId(membership);
        return userId ? [userId] : [];
      }),
    ),
  ];
}

async function subscribedUserIds(
  db: Db,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) {
    return new Set();
  }

  const unsubscribedRows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, [...userIds].sort()),
        eq(users.emailUnsubscribed, true),
      ),
    );
  const unsubscribed = new Set(
    unsubscribedRows.map((row) => {
      return row.id;
    }),
  );
  return new Set(
    userIds.filter((userId) => {
      return !unsubscribed.has(userId);
    }),
  );
}

async function resolveRecipients(
  db: Db,
  clerk: ClerkClient,
  userIds: readonly string[],
  signal: AbortSignal,
): Promise<Recipient[]> {
  const eligibleUserIds = await subscribedUserIds(db, userIds);
  signal.throwIfAborted();

  const byEmail = new Map<string, Recipient>();
  for (const userId of userIds) {
    if (!eligibleUserIds.has(userId)) {
      continue;
    }

    const email = await getUserEmail(db, clerk, userId);
    signal.throwIfAborted();
    if (!email) {
      continue;
    }

    const key = email.toLowerCase();
    if (!byEmail.has(key)) {
      byEmail.set(key, { userId, email });
    }
  }
  return [...byEmail.values()];
}

async function suppressedEmailKeys(
  db: Db,
  emails: readonly string[],
): Promise<Set<string>> {
  if (emails.length === 0) {
    return new Set();
  }

  const lowerEmails = emails.map((email) => {
    return email.toLowerCase();
  });
  const rows = await db
    .select({ emailAddress: emailSuppressions.emailAddress })
    .from(emailSuppressions)
    .where(
      sql`lower(${emailSuppressions.emailAddress}) IN (${sql.join(
        lowerEmails.map((email) => {
          return sql`${email}`;
        }),
        sql`, `,
      )})`,
    );

  return new Set(
    rows.map((row) => {
      return row.emailAddress.toLowerCase();
    }),
  );
}

async function orgDisplayName(db: Db, orgId: string): Promise<string> {
  const [cached] = await db
    .select({ name: orgCache.name })
    .from(orgCache)
    .where(eq(orgCache.orgId, orgId))
    .limit(1);
  const name = cached?.name.trim();
  return name || "Your organization";
}

export const enqueueCreditLowBalanceAlert$ = command(
  async (
    { get, set },
    args: CreditLowBalanceAlertArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const clerk = get(clerk$);
    const memberships = await listCurrentOrgMemberships(
      clerk,
      args.orgId,
      signal,
    );
    await refreshOrgMemberCache(db, args.orgId, memberships);
    signal.throwIfAborted();

    const userIds = adminUserIds(memberships);
    if (userIds.length === 0) {
      L.warn("No current org admin recipients for low-credit alert", {
        orgId: args.orgId,
      });
      return;
    }

    const recipients = await resolveRecipients(db, clerk, userIds, signal);
    const suppressed = await suppressedEmailKeys(
      db,
      recipients.map((recipient) => {
        return recipient.email;
      }),
    );
    signal.throwIfAborted();

    const deliverableRecipients = recipients.filter((recipient) => {
      return !suppressed.has(recipient.email.toLowerCase());
    });
    if (deliverableRecipients.length === 0) {
      L.warn("No eligible org admin recipients for low-credit alert", {
        orgId: args.orgId,
      });
      return;
    }

    const orgName = await orgDisplayName(db, args.orgId);
    signal.throwIfAborted();
    const billingUrl = `${env("APP_URL")}/?settings=billing&billingView=credits`;

    await db.insert(emailOutbox).values(
      deliverableRecipients.map((recipient) => {
        const unsubscribeUrl = buildUnsubscribeUrl(recipient.userId);
        const template = {
          template: "credit-low-balance",
          props: {
            orgName,
            remainingCredits: args.remainingCredits,
            thresholdCredits: args.thresholdCredits,
            billingUrl,
            unsubscribeUrl,
          },
        } satisfies EmailTemplate;
        return {
          fromAddress: buildFromAddress("vm0"),
          toAddresses: recipient.email,
          ccAddresses: null,
          subject: "Your VM0 credits are running low",
          replyTo: null,
          headers: buildUnsubscribeHeaders(unsubscribeUrl),
          template,
          postSendAction: null,
          status: "pending",
          attempts: 0,
        };
      }),
    );
  },
);
