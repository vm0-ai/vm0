import { createHash, randomBytes, randomUUID } from "node:crypto";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import {
  PRIVACY_POLICY_VERSION,
  privacyPurposesSchema,
  type PrivacyChoiceState,
  type PrivacyChoiceUpdate,
  type PrivacyPurposes,
} from "@okouai/api-contracts/contracts/privacy-choices";
import {
  privacyChoices,
  privacyChoiceRevisions,
} from "@okouai/db/schema/privacy-choice";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

type ChoiceRow = typeof privacyChoices.$inferSelect;
type Consent = PrivacyPurposes["saleSharing"];
type ChoiceEvidence = {
  readonly purposes: PrivacyPurposes;
  readonly source: "explicit" | "gpc";
};
type ChoiceResult =
  | { readonly ok: true; readonly state: PrivacyChoiceState }
  | {
      readonly ok: false;
      readonly reason: "missing" | "stale" | "linked" | "session";
    };

const UNKNOWN: PrivacyPurposes = Object.freeze({
  saleSharing: "unknown",
  advertising: "unknown",
  marketingAnalytics: "unknown",
});
const DENIED: PrivacyPurposes = Object.freeze({
  saleSharing: "denied",
  advertising: "denied",
  marketingAnalytics: "denied",
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function stateOf(row: ChoiceRow | undefined): PrivacyChoiceState {
  if (!row) {
    return {
      subjectId: null,
      revision: null,
      purposes: UNKNOWN,
      source: null,
      policyVersion: PRIVACY_POLICY_VERSION,
      updatedAt: null,
      advertisingAllowed: false,
      marketingAnalyticsAllowed: false,
    };
  }
  const parsed = privacyPurposesSchema.safeParse({
    saleSharing: row.saleSharing,
    advertising: row.advertising,
    marketingAnalytics: row.marketingAnalytics,
  });
  const source =
    row.source === "explicit" || row.source === "gpc" ? row.source : null;
  const verified =
    parsed.success &&
    source !== null &&
    row.updatedAt !== null &&
    row.policyVersion === PRIVACY_POLICY_VERSION;
  const purposes = source === "gpc" ? DENIED : verified ? parsed.data : UNKNOWN;
  const saleSharingAllowed = purposes.saleSharing === "granted";
  return {
    subjectId: row.id,
    revision: row.revision,
    purposes,
    source,
    policyVersion: row.policyVersion,
    updatedAt: row.updatedAt?.toISOString() ?? null,
    advertisingAllowed:
      saleSharingAllowed && purposes.advertising === "granted",
    marketingAnalyticsAllowed:
      saleSharingAllowed && purposes.marketingAnalytics === "granted",
  };
}

function allDenied(purposes: PrivacyPurposes): boolean {
  return (
    purposes.saleSharing === "denied" &&
    purposes.advertising === "denied" &&
    purposes.marketingAnalytics === "denied"
  );
}

function normalizedChoice(choice: PrivacyChoiceUpdate): ChoiceEvidence {
  if (choice.source === "gpc") {
    return { source: "gpc", purposes: DENIED };
  }
  return {
    source: "explicit",
    purposes:
      choice.purposes.saleSharing === "denied" ? DENIED : choice.purposes,
  };
}

async function saveChoice(
  tx: Tx,
  row: ChoiceRow,
  choice: ChoiceEvidence,
  forceRevision: boolean,
  signal: AbortSignal,
): Promise<ChoiceRow> {
  // Repeated GPC observations and explicit denials must not erase a saved GPC.
  const source =
    row.source === "gpc" && allDenied(choice.purposes) ? "gpc" : choice.source;
  if (
    !forceRevision &&
    row.source === source &&
    row.policyVersion === PRIVACY_POLICY_VERSION &&
    row.saleSharing === choice.purposes.saleSharing &&
    row.advertising === choice.purposes.advertising &&
    row.marketingAnalytics === choice.purposes.marketingAnalytics
  ) {
    return row;
  }

  const updatedAt = nowDate();
  const revision = randomUUID();
  const [updated] = await tx
    .update(privacyChoices)
    .set({
      ...choice.purposes,
      source,
      revision,
      policyVersion: PRIVACY_POLICY_VERSION,
      updatedAt,
    })
    .where(eq(privacyChoices.id, row.id))
    .returning();
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Privacy subject disappeared during its locked update");
  }
  await tx.insert(privacyChoiceRevisions).values({
    subjectId: row.id,
    revision,
    ...choice.purposes,
    source,
    policyVersion: PRIVACY_POLICY_VERSION,
    recordedAt: updatedAt,
  });
  signal.throwIfAborted();
  return updated;
}

async function applyChoice(
  tx: Tx,
  {
    row,
    update,
    gpc,
    mayGrant,
  }: {
    readonly row: ChoiceRow;
    readonly update?: PrivacyChoiceUpdate;
    readonly gpc: boolean;
    readonly mayGrant: boolean;
  },
  signal: AbortSignal,
): Promise<ChoiceResult> {
  const choice = gpc ? { source: "gpc" as const } : update;
  if (!choice) {
    return { ok: true, state: stateOf(row) };
  }
  const normalized = normalizedChoice(choice);
  if (
    choice.source === "explicit" &&
    !allDenied(normalized.purposes) &&
    choice.expectedRevision !== row.revision &&
    !(row.source === null && choice.expectedRevision === null)
  ) {
    return { ok: false, reason: "stale" };
  }
  const current = stateOf(row).purposes;
  if (
    !mayGrant &&
    ((normalized.purposes.saleSharing === "granted" &&
      current.saleSharing !== "granted") ||
      (normalized.purposes.advertising === "granted" &&
        current.advertising !== "granted") ||
      (normalized.purposes.marketingAnalytics === "granted" &&
        current.marketingAnalytics !== "granted"))
  ) {
    return { ok: false, reason: "session" };
  }
  // A withdrawal wins even when another tab changed the revision. Grants need
  // the exact observed revision and must never be automatically rebased.
  // A fresh explicit withdrawal also invalidates prepared grants when consent
  // was already denied. Passive GPC observations remain idempotent.
  const updated = await saveChoice(
    tx,
    row,
    normalized,
    update?.source === "explicit" && allDenied(normalized.purposes),
    signal,
  );
  return { ok: true, state: stateOf(updated) };
}

async function lockUser(
  tx: Tx,
  userId: string,
  signal: AbortSignal,
): Promise<ChoiceRow> {
  await tx
    .insert(privacyChoices)
    .values({ userId, policyVersion: PRIVACY_POLICY_VERSION })
    .onConflictDoNothing({ target: privacyChoices.userId });
  signal.throwIfAborted();
  const row = await lockExistingUser(tx, userId, signal);
  if (!row) {
    throw new Error("Privacy subject missing after creation");
  }
  return row;
}

async function lockExistingUser(
  tx: Tx,
  userId: string,
  signal: AbortSignal,
): Promise<ChoiceRow | undefined> {
  const [row] = await tx
    .select()
    .from(privacyChoices)
    .where(eq(privacyChoices.userId, userId))
    .for("update");
  signal.throwIfAborted();
  return row;
}

async function lockAnonymous(
  tx: Tx,
  token: string,
  signal: AbortSignal,
): Promise<ChoiceRow | undefined> {
  const [row] = await tx
    .select()
    .from(privacyChoices)
    .where(eq(privacyChoices.tokenHash, hashToken(token)))
    .for("update");
  signal.throwIfAborted();
  return row;
}

export const createAnonymousPrivacyChoice$ = command(
  async (
    { set },
    args: { readonly choice?: PrivacyChoiceUpdate; readonly gpc: boolean },
    signal: AbortSignal,
  ) => {
    const token = `pc_${randomBytes(32).toString("hex")}`;
    const result = await set(writeDb$).transaction(async (tx) => {
      const [row] = await tx
        .insert(privacyChoices)
        .values({
          tokenHash: hashToken(token),
          policyVersion: PRIVACY_POLICY_VERSION,
        })
        .returning();
      signal.throwIfAborted();
      if (!row) {
        throw new Error("Anonymous privacy subject missing after creation");
      }
      return await applyChoice(
        tx,
        { row, update: args.choice, gpc: args.gpc, mayGrant: true },
        signal,
      );
    });
    signal.throwIfAborted();
    return { token, result };
  },
);

export const anonymousPrivacyChoice$ = command(
  async (
    { set },
    args: {
      readonly token: string;
      readonly update?: PrivacyChoiceUpdate;
      readonly gpc: boolean;
    },
    signal: AbortSignal,
  ): Promise<ChoiceResult> => {
    const result = await set(writeDb$).transaction(
      async (tx): Promise<ChoiceResult> => {
        // All browser operations lock browser -> person, including association.
        // Once linked, the token resolves the person's current revision directly.
        const browser = await lockAnonymous(tx, args.token, signal);
        if (!browser) {
          return { ok: false, reason: "missing" };
        }
        const row = browser.linkedUserId
          ? await lockExistingUser(tx, browser.linkedUserId, signal)
          : browser;
        if (!row) {
          throw new Error("Linked privacy subject is unavailable");
        }
        return await applyChoice(
          tx,
          {
            row,
            update: args.update,
            gpc: args.gpc,
            mayGrant: browser.linkedUserId === null,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    return result;
  },
);

export const userPrivacyChoice$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly update?: PrivacyChoiceUpdate;
      readonly gpc: boolean;
    },
    signal: AbortSignal,
  ): Promise<ChoiceResult> => {
    const result = await set(writeDb$).transaction(async (tx) => {
      if (!args.update && !args.gpc) {
        const [row] = await tx
          .select()
          .from(privacyChoices)
          .where(eq(privacyChoices.userId, args.userId));
        signal.throwIfAborted();
        return { ok: true as const, state: stateOf(row) };
      }
      const row = await lockUser(tx, args.userId, signal);
      return await applyChoice(
        tx,
        { row, update: args.update, gpc: args.gpc, mayGrant: true },
        signal,
      );
    });
    signal.throwIfAborted();
    return result;
  },
);

function moreRestrictive(left: Consent, right: Consent): Consent {
  if (left === "denied" || right === "denied") {
    return "denied";
  }
  if (left === "unknown" || right === "unknown") {
    return "unknown";
  }
  return "granted";
}

export const associatePrivacyChoice$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly token: string;
      readonly gpc: boolean;
    },
    signal: AbortSignal,
  ): Promise<ChoiceResult> => {
    const result = await set(writeDb$).transaction(
      async (tx): Promise<ChoiceResult> => {
        const browser = await lockAnonymous(tx, args.token, signal);
        if (!browser) {
          return { ok: false, reason: "missing" };
        }
        if (browser.linkedUserId && browser.linkedUserId !== args.userId) {
          return { ok: false, reason: "linked" };
        }
        const person = await lockUser(tx, args.userId, signal);
        if (browser.linkedUserId) {
          return await applyChoice(
            tx,
            { row: person, gpc: args.gpc, mayGrant: true },
            signal,
          );
        }

        const incoming = args.gpc
          ? { ...stateOf(browser), purposes: DENIED, source: "gpc" as const }
          : stateOf(browser);
        const current = stateOf(person);
        let merged = person;
        if (incoming.source) {
          // An initial verified browser choice can establish the person's state.
          // Subsequent association only restricts; it can never restore a grant.
          const purposes: PrivacyPurposes =
            person.source === null
              ? incoming.purposes
              : {
                  saleSharing: moreRestrictive(
                    current.purposes.saleSharing,
                    incoming.purposes.saleSharing,
                  ),
                  advertising: moreRestrictive(
                    current.purposes.advertising,
                    incoming.purposes.advertising,
                  ),
                  marketingAnalytics: moreRestrictive(
                    current.purposes.marketingAnalytics,
                    incoming.purposes.marketingAnalytics,
                  ),
                };
          merged = await saveChoice(
            tx,
            person,
            {
              purposes: purposes.saleSharing === "denied" ? DENIED : purposes,
              source: incoming.source,
            },
            false,
            signal,
          );
        }
        await tx
          .update(privacyChoices)
          .set({ linkedUserId: args.userId })
          .where(eq(privacyChoices.id, browser.id));
        signal.throwIfAborted();
        return { ok: true, state: stateOf(merged) };
      },
    );
    signal.throwIfAborted();
    return result;
  },
);
