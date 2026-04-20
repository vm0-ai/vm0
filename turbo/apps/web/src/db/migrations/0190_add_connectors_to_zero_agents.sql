-- Step 1: Add nullable column
ALTER TABLE "zero_agents" ADD COLUMN "connectors" jsonb;

-- Step 2: Backfill from compose content (exclude seed skills)
UPDATE zero_agents za
SET connectors = COALESCE(
  (
    SELECT jsonb_agg(short_name ORDER BY short_name)
    FROM (
      SELECT regexp_replace(
        skill::text,
        '^"https://github\.com/vm0-ai/vm0-skills/tree/main/(.+)"$',
        '\1'
      ) AS short_name
      FROM agent_composes ac
      JOIN agent_compose_versions acv ON ac.head_version_id = acv.id
      CROSS JOIN LATERAL jsonb_array_elements(
        acv.content -> 'agents' -> (
          SELECT key FROM jsonb_each(acv.content -> 'agents') LIMIT 1
        ) -> 'skills'
      ) AS skill
      WHERE ac.org_id = za.org_id
        AND ac.name = za.name
        AND skill::text LIKE '"https://github.com/vm0-ai/vm0-skills/tree/main/%"'
        AND regexp_replace(skill::text, '^"https://github\.com/vm0-ai/vm0-skills/tree/main/(.+)"$', '\1')
            NOT IN ('vm0','deep-dive','account-reconciliation','analysis-qa','audit-readiness','brand-guidelines','campaign-strategy','competitor-matrix','contract-redline','copywriting','customer-intel','customer-reply','data-profiling','escalation-brief','flux-analysis','gaap-reporting','issue-triage','journal-entries','kb-authoring','legal-briefing','legal-risk-scoring','marketing-analytics','nda-screening','period-close','prd-writing','privacy-compliance','product-metrics','reply-templates','research-synthesis','roadmap-planning','sql-cookbook','stats-methods','status-updates')
    ) sub
  ),
  '[]'::jsonb
);

-- Step 3: Set NOT NULL with default
ALTER TABLE "zero_agents" ALTER COLUMN "connectors" SET NOT NULL;
ALTER TABLE "zero_agents" ALTER COLUMN "connectors" SET DEFAULT '[]'::jsonb;
