import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import {
  marketingPrivacyReceipts,
  privacyChoices,
} from "@okouai/db/schema/privacy-choice";
import { PRIVACY_POLICY_VERSION } from "@okouai/api-contracts/contracts/privacy-choices";
import type {
  MarketingPrivacyDecision,
  MarketingPrivacyRequest,
  PrivacyCaptureContext,
} from "@okouai/api-contracts/contracts/marketing-privacy";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { privacyChoiceStateOf } from "./privacy-choices.service";

export const captureMarketingPrivacy$ = command(
  async (
    { set },
    args: { readonly userId: string; readonly context?: PrivacyCaptureContext },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const context = args.context;
    if (!context) {
      return null;
    }
    const result = await set(writeDb$).transaction(async (tx) => {
      const [choice] = await tx
        .select()
        .from(privacyChoices)
        .where(
          and(
            eq(privacyChoices.id, context.subjectId),
            eq(privacyChoices.userId, args.userId),
          ),
        )
        .for("update");
      signal.throwIfAborted();
      const observedAt = new Date(context.capturedAt);
      const capturedAt = nowDate();
      if (
        !choice ||
        choice.revision !== context.revision ||
        !choice.updatedAt ||
        observedAt < choice.updatedAt ||
        observedAt > capturedAt
      ) {
        return null;
      }
      const state = privacyChoiceStateOf(choice);
      if (!state.advertisingAllowed && !state.marketingAnalyticsAllowed) {
        return null;
      }
      const [receipt] = await tx
        .insert(marketingPrivacyReceipts)
        .values({
          subjectId: choice.id,
          privacyRevision: choice.revision,
          advertisingEpoch: state.advertisingAllowed
            ? choice.advertisingEpoch
            : null,
          marketingAnalyticsEpoch: state.marketingAnalyticsAllowed
            ? choice.marketingAnalyticsEpoch
            : null,
          policyVersion: PRIVACY_POLICY_VERSION,
          capturedAt,
        })
        .returning({ id: marketingPrivacyReceipts.id });
      signal.throwIfAborted();
      if (!receipt) {
        throw new Error("Marketing privacy receipt missing after creation");
      }
      return receipt.id;
    });
    signal.throwIfAborted();
    return result;
  },
);

export const authorizeMarketingDelivery$ = command(
  async (
    { set },
    args: MarketingPrivacyRequest,
    signal: AbortSignal,
  ): Promise<MarketingPrivacyDecision> => {
    // Read the primary database on every attempt; a lagging replica or cached
    // allowed result cannot establish the latest withdrawal state.
    const [record] = await set(writeDb$)
      .select({ receipt: marketingPrivacyReceipts, choice: privacyChoices })
      .from(marketingPrivacyReceipts)
      .innerJoin(
        privacyChoices,
        eq(privacyChoices.id, marketingPrivacyReceipts.subjectId),
      )
      .where(eq(marketingPrivacyReceipts.id, args.receiptId));
    signal.throwIfAborted();
    if (!record) {
      return { allowed: false, reason: "unverified_context" };
    }
    const { receipt, choice } = record;
    if (choice.userId !== args.userId) {
      return { allowed: false, reason: "subject_mismatch" };
    }
    if (receipt.policyVersion !== PRIVACY_POLICY_VERSION) {
      return { allowed: false, reason: "unverified_context" };
    }
    const eventTime = new Date(args.eventTime);
    if (eventTime < receipt.capturedAt || eventTime > nowDate()) {
      return { allowed: false, reason: "event_before_capture" };
    }
    const state = privacyChoiceStateOf(choice);
    const advertising = args.purpose === "advertising";
    const capturedEpoch = advertising
      ? receipt.advertisingEpoch
      : receipt.marketingAnalyticsEpoch;
    const currentEpoch = advertising
      ? choice.advertisingEpoch
      : choice.marketingAnalyticsEpoch;
    const allowed = advertising
      ? state.advertisingAllowed
      : state.marketingAnalyticsAllowed;
    if (!capturedEpoch || !allowed) {
      return { allowed: false, reason: "purpose_denied" };
    }
    if (capturedEpoch !== currentEpoch) {
      return { allowed: false, reason: "withdrawn" };
    }
    // Equal purpose epochs prove uninterrupted permission from capture through
    // the event and this send. Later opt-in never repairs a withdrawn receipt.
    return { allowed: true, reason: null };
  },
);
