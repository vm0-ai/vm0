import { resolveSkillRef } from "@vm0/core/github-url";
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
