/**
 * Default skills always included in zero agent composes.
 * Source: https://github.com/vm0-ai/vm0-skills
 *
 * These live server-side only so the frontend never sends stale seed skills.
 */
export const SEED_SKILLS: readonly string[] = [
  "computer-use",
  "gen",
  "workflow-setup",
] as const;

/**
 * The `goal` skill is mounted for API runs separately from the default compose
 * seed list. Its body is still synced to storage by cron-sync-skills like every
 * other skill in the repo, so run creation can mount it without listing it here.
 */
export const GOAL_SKILL_NAME = "goal";
