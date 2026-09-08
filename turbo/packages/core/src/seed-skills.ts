/**
 * Default skills always included in agent composes.
 * Source: https://github.com/vm0-ai/vm0-skills
 *
 * These live server-side only so the frontend never sends stale seed skills.
 */
export const SEED_SKILLS: readonly string[] = [
  "computer-use",
  "gen",
  "ppt-avatar-video",
  "workflow-setup",
] as const;

/**
 * The `goal` skill is mounted for API runs separately from the default compose
 * seed list. Its body is still synced to storage by cron-sync-skills like every
 * other skill in the repo, so run creation can mount it without listing it here.
 */
export const GOAL_SKILL_NAME = "goal";

/** Mounted only for runs whose organization or user has Intro Video enabled. */
export const INTRO_VIDEO_SKILL_NAME = "intro-video";
