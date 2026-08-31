import {
  adAttributionMetadataSchema,
  type AdAttributionMetadata,
} from "@okouai/api-contracts/contracts/acquisition-attribution";
import { orgMetadataLegacyWrites } from "@okouai/db/operations/org-metadata-legacy-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, isNull } from "drizzle-orm";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

const ORG_ATTRIBUTION_FIELDS = [
  ["source_type", "acquisitionSourceType"],
  ["vm0_source", "acquisitionVm0Source"],
  ["vm0_campaign_id", "acquisitionCampaignId"],
  ["vm0_ad_group_id", "acquisitionAdGroupId"],
  ["utm_campaign", "acquisitionCampaign"],
  ["utm_source", "acquisitionUtmSource"],
  ["utm_medium", "acquisitionUtmMedium"],
  ["utm_content", "acquisitionUtmContent"],
  ["utm_term", "acquisitionUtmTerm"],
  ["gclid", "acquisitionGclid"],
  ["gbraid", "acquisitionGbraid"],
  ["wbraid", "acquisitionWbraid"],
  ["ga_client_id", "acquisitionGaClientId"],
  ["landing_host", "acquisitionLandingHost"],
  ["landing_path", "acquisitionLandingPath"],
  ["referrer_domain", "acquisitionReferrerDomain"],
] as const;

type OrgAttributionField = (typeof ORG_ATTRIBUTION_FIELDS)[number][1];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clerk stores a bookkeeping timestamp alongside the attribution payload.
 * Keep that implementation detail out of the strict API contract when the
 * value is read back for checkout or org persistence.
 */
export function parseStoredSignupAttribution(
  value: unknown,
): AdAttributionMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { recorded_at: _recordedAt, ...metadata } = value;
  const parsed = adAttributionMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : undefined;
}

function orgAttributionValues(
  attribution: Readonly<Record<string, string | undefined>> | undefined,
): Partial<Record<OrgAttributionField, string>> {
  const values: Partial<Record<OrgAttributionField, string>> = {};
  for (const [sourceKey, targetKey] of ORG_ATTRIBUTION_FIELDS) {
    const value = attribution?.[sourceKey]?.trim();
    if (value) {
      values[targetKey] = value;
    }
  }
  return values;
}

export function mergeFirstTouchAttribution(
  provided: AdAttributionMetadata | undefined,
  stored: AdAttributionMetadata | undefined,
): AdAttributionMetadata | undefined {
  if (!provided && !stored) {
    return undefined;
  }

  // Clerk contains the first-touch record. It wins over a later browser
  // payload, while the payload can fill fields that were not available when
  // the user record was created, such as a newly added client identifier.
  return { ...provided, ...stored };
}

export const persistOrgAcquisitionAttribution$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly attribution:
        | Readonly<Record<string, string | undefined>>
        | undefined;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const values = orgAttributionValues(args.attribution);
    if (Object.keys(values).length === 0) {
      return false;
    }

    const recordedAt = nowDate();
    const db = set(writeDb$);

    // An org can be created just before the first billing request. Ensure the
    // metadata row exists, then only fill the attribution columns once. The
    // timestamp is the immutable first-touch guard under concurrent checkouts.
    const [inserted] = await db
      .insert(orgMetadataLegacyWrites)
      .values({
        orgId: args.orgId,
        credits: 0,
        ...values,
        acquisitionRecordedAt: recordedAt,
        updatedAt: recordedAt,
      })
      .onConflictDoNothing({ target: orgMetadataLegacyWrites.orgId })
      .returning({ orgId: orgMetadataLegacyWrites.orgId });
    signal.throwIfAborted();
    if (inserted) {
      return true;
    }

    const [updated] = await db
      .update(orgMetadata)
      .set({
        ...values,
        acquisitionRecordedAt: recordedAt,
        updatedAt: recordedAt,
      })
      .where(
        and(
          eq(orgMetadata.orgId, args.orgId),
          isNull(orgMetadata.acquisitionRecordedAt),
        ),
      )
      .returning({ orgId: orgMetadata.orgId });
    signal.throwIfAborted();
    return Boolean(updated);
  },
);
