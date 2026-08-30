import { command } from "ccstate";
import type {
  GoogleAdsConversionMilestone,
  GoogleAdsConversionMilestoneKind,
} from "@okouai/api-contracts/contracts/acquisition-attribution";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { connectors } from "@okouai/db/schema/connector";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { usageEvent } from "@okouai/db/schema/usage-event";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  notInArray,
} from "drizzle-orm";

import { db$ } from "../external/db";

const GOOGLE_ADS_ACCOUNT_TIME_ZONE = "America/Los_Angeles";
const FREE_TRIAL_CREDIT_SOURCES = Object.freeze([
  "onboarding",
  "starter_grant",
]);
const INTERNAL_ORG_IDS = Object.freeze([
  "org_3AW2PMh2ZLwsNXJAH6rufx2HUQu",
  "org_3EIyMn16PGrzscXQQQxvZTaiIUW",
  "org_3C3uya6QPgVprQsAaDqCPgoBry6",
  "org_3AVxy08nV0RDyXtFj19Ohv0i6YD",
  "org_3AW2PmtD1KxaZivngfL2Ud0sHBf",
  "org_3AW2MBAPXq6wUJZOd4hz97Az7I0",
  "org_3BTOoX3y81Ngrjtu1LI1dqBzXcB",
  "org_3ApJjGcaXGOqK9X7DaFcVemqBnw",
  "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
  "org_3AW2QiNyfbz196bcHexc1E35nOq",
]);

function googleAdsAccountDay(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: GOOGLE_ADS_ACCOUNT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => {
    return part.type === "year";
  })?.value;
  const month = parts.find((part) => {
    return part.type === "month";
  })?.value;
  const day = parts.find((part) => {
    return part.type === "day";
  })?.value;
  return `${year}-${month}-${day}`;
}

function milestone(
  kind: GoogleAdsConversionMilestoneKind,
  transactionId: string,
): GoogleAdsConversionMilestone {
  return { kind, transactionId };
}

function runMilestones(
  userId: string,
  rows: readonly { readonly completedAt: Date | null }[],
): GoogleAdsConversionMilestone[] {
  const completedAt = rows.flatMap((row) => {
    return row.completedAt ? [row.completedAt] : [];
  });
  const milestones: GoogleAdsConversionMilestone[] = [];
  if (completedAt[0]) {
    milestones.push(
      milestone("first_run_completed", `gdm-first_run_completed-${userId}`),
    );
  }
  if (completedAt[1]) {
    milestones.push(
      milestone("second_run_completed", `gdm-second_run_completed-${userId}`),
    );
  }

  const firstDay = completedAt[0]
    ? googleAdsAccountDay(completedAt[0])
    : undefined;
  if (
    firstDay &&
    completedAt.some((date) => {
      return googleAdsAccountDay(date) !== firstDay;
    })
  ) {
    milestones.push(
      milestone(
        "multi_day_run_completed",
        `gdm-multi_day_run_completed-${userId}`,
      ),
    );
  }
  return milestones;
}

function connectorMilestones(
  userId: string,
  rows: readonly { readonly connectorSlug: string | null }[],
): GoogleAdsConversionMilestone[] {
  const distinctConnectorSlugs = new Set(
    rows.flatMap((row) => {
      return row.connectorSlug ? [row.connectorSlug] : [];
    }),
  );
  const milestones: GoogleAdsConversionMilestone[] = [];
  if (distinctConnectorSlugs.size >= 1) {
    milestones.push(
      milestone(
        "one_connector_connected",
        `gdm-one_connector_connected-${userId}`,
      ),
    );
  }
  if (distinctConnectorSlugs.size >= 2) {
    milestones.push(
      milestone(
        "two_connectors_connected",
        `gdm-two_connectors_connected-${userId}`,
      ),
    );
  }
  return milestones;
}

interface TrialGrant {
  readonly id: string;
  readonly orgId: string;
  readonly amount: number;
  readonly createdAt: Date;
}

interface ProcessedUsage {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly creditsCharged: number | null;
  readonly processedAt: Date | null;
}

function freeTrialMilestones(
  userId: string,
  grants: readonly TrialGrant[],
  usageRows: readonly ProcessedUsage[],
): GoogleAdsConversionMilestone[] {
  const milestones: GoogleAdsConversionMilestone[] = [];
  for (const grant of grants) {
    if (grant.amount <= 0) {
      continue;
    }
    let cumulativeCredits = 0;
    for (const usageRow of usageRows) {
      if (
        usageRow.orgId !== grant.orgId ||
        !usageRow.processedAt ||
        usageRow.processedAt < grant.createdAt
      ) {
        continue;
      }
      cumulativeCredits += usageRow.creditsCharged ?? 0;
      if (cumulativeCredits < grant.amount) {
        continue;
      }
      if (usageRow.userId === userId) {
        milestones.push(
          milestone(
            "free_trial_completed",
            `gdm-free-trial-completed-${grant.id}`,
          ),
        );
      }
      break;
    }
  }
  return milestones;
}

export const googleAdsConversionMilestonesForUser$ = command(
  async ({ get }, userId: string, signal: AbortSignal) => {
    const db = get(db$);
    const [completedRuns, connectedConnectors, userUsageRows] =
      await Promise.all([
        db
          .select({ completedAt: agentRuns.completedAt })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.userId, userId),
              eq(agentRuns.status, "completed"),
              isNotNull(agentRuns.completedAt),
              notInArray(agentRuns.orgId, [...INTERNAL_ORG_IDS]),
            ),
          )
          .orderBy(asc(agentRuns.completedAt), asc(agentRuns.id)),
        db
          .select({ connectorSlug: connectors.connectorSlug })
          .from(connectors)
          .where(
            and(
              eq(connectors.userId, userId),
              isNotNull(connectors.connectorSlug),
              notInArray(connectors.orgId, [...INTERNAL_ORG_IDS]),
            ),
          )
          .orderBy(asc(connectors.createdAt), asc(connectors.id)),
        db
          .select({
            orgId: usageEvent.orgId,
            processedAt: usageEvent.processedAt,
          })
          .from(usageEvent)
          .where(
            and(
              eq(usageEvent.userId, userId),
              eq(usageEvent.status, "processed"),
              gt(usageEvent.creditsCharged, 0),
              isNotNull(usageEvent.processedAt),
              notInArray(usageEvent.orgId, [...INTERNAL_ORG_IDS]),
            ),
          )
          .orderBy(asc(usageEvent.processedAt), asc(usageEvent.id)),
      ]);
    signal.throwIfAborted();

    const orgIds = [
      ...new Set(
        userUsageRows.map((row) => {
          return row.orgId;
        }),
      ),
    ];
    let trialMilestones: GoogleAdsConversionMilestone[] = [];
    if (orgIds.length > 0) {
      const grants = await db
        .select({
          id: creditExpiresRecord.id,
          orgId: creditExpiresRecord.orgId,
          amount: creditExpiresRecord.amount,
          createdAt: creditExpiresRecord.createdAt,
        })
        .from(creditExpiresRecord)
        .where(
          and(
            inArray(creditExpiresRecord.orgId, orgIds),
            inArray(creditExpiresRecord.source, [...FREE_TRIAL_CREDIT_SOURCES]),
            eq(creditExpiresRecord.remaining, 0),
          ),
        )
        .orderBy(
          asc(creditExpiresRecord.createdAt),
          asc(creditExpiresRecord.id),
        );
      signal.throwIfAborted();

      const earliestGrantCreatedAt = grants[0]?.createdAt;
      if (earliestGrantCreatedAt) {
        const usageRows = await db
          .select({
            id: usageEvent.id,
            orgId: usageEvent.orgId,
            userId: usageEvent.userId,
            creditsCharged: usageEvent.creditsCharged,
            processedAt: usageEvent.processedAt,
          })
          .from(usageEvent)
          .where(
            and(
              inArray(usageEvent.orgId, orgIds),
              eq(usageEvent.status, "processed"),
              gt(usageEvent.creditsCharged, 0),
              isNotNull(usageEvent.processedAt),
              gte(usageEvent.processedAt, earliestGrantCreatedAt),
            ),
          )
          .orderBy(asc(usageEvent.processedAt), asc(usageEvent.id));
        signal.throwIfAborted();
        trialMilestones = freeTrialMilestones(userId, grants, usageRows);
      }
    }

    return [
      ...runMilestones(userId, completedRuns),
      ...connectorMilestones(userId, connectedConnectors),
      ...trialMilestones,
    ];
  },
);
