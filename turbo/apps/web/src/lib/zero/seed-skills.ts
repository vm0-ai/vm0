import { createHash } from "node:crypto";
import { resolveSkillRef } from "@vm0/core/github-url";
import { getSkillStorageName, SYSTEM_ORG_ID } from "@vm0/core/storage-names";
import type { skills } from "../../db/schema/skill";

/**
 * Default skills always included in zero agent composes.
 * Source: https://github.com/vm0-ai/the-seed
 *
 * These live server-side only so the frontend never sends stale seed skills.
 */
export const SEED_SKILLS: readonly string[] = [
  "deep-dive",
  "account-reconciliation",
  "analysis-qa",
  "audit-readiness",
  "brand-guidelines",
  "campaign-strategy",
  "competitor-matrix",
  "contract-redline",
  "copywriting",
  "customer-intel",
  "customer-reply",
  "data-profiling",
  "escalation-brief",
  "flux-analysis",
  "gaap-reporting",
  "issue-triage",
  "journal-entries",
  "kb-authoring",
  "legal-briefing",
  "legal-risk-scoring",
  "marketing-analytics",
  "nda-screening",
  "period-close",
  "prd-writing",
  "privacy-compliance",
  "product-metrics",
  "reply-templates",
  "research-synthesis",
  "roadmap-planning",
  "sql-cookbook",
  "stats-methods",
  "status-updates",
] as const;

/**
 * Build skill insert values from a list of skill names.
 * Shared by dev-seed and test helpers to avoid duplicated URL/frontmatter construction.
 */
export function buildSeedSkillValues(
  names: readonly string[],
): (typeof skills.$inferInsert)[] {
  return names.map((name) => {
    const url = resolveSkillRef(name);
    const fullPath = url.replace("https://github.com/", "");
    return {
      url,
      name,
      fullPath,
      versionHash: null,
      frontmatter: {
        name,
        description: `${name} skill`,
      },
    };
  });
}

interface SeedSkillStorageEntry {
  name: string;
  fullPath: string;
  storageName: string;
  versionId: string;
  s3Prefix: string;
  s3Key: string;
}

/**
 * Build deterministic system storage placeholders for local/dev seed data.
 * Production skill sync replaces these with real archive-backed versions.
 */
export function buildSeedSkillStorageEntries(
  names: readonly string[],
): SeedSkillStorageEntry[] {
  return names.map((name) => {
    const url = resolveSkillRef(name);
    const fullPath = url.replace("https://github.com/", "");
    const storageName = getSkillStorageName(fullPath);
    const versionId = createHash("sha256")
      .update(`dev-seed:skill:${url}`)
      .digest("hex");
    const s3Prefix = `${SYSTEM_ORG_ID}/volume/${storageName}`;

    return {
      name,
      fullPath,
      storageName,
      versionId,
      s3Prefix,
      s3Key: `${s3Prefix}/${versionId}`,
    };
  });
}
