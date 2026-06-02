import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
} from "@vm0/connectors/connectors";

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
  "gen",
  "issue-triage",
  "journal-entries",
  "kb-authoring",
  "legal-briefing",
  "legal-risk-scoring",
  "marketing-analytics",
  "nda-screening",
  "paid-ads-operator",
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

export function getSeedSkillNames(): string[] {
  const connectorSkillNames = CONNECTOR_TYPE_KEYS.filter((type) => {
    return Object.values(CONNECTOR_TYPES[type].authMethods).some((method) => {
      return !method.featureFlag;
    });
  });
  return [...new Set([...SEED_SKILLS, ...connectorSkillNames])];
}
