import { computed } from "ccstate";
import type { ComboboxOption } from "@vm0/ui";
import {
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
  DEFAULT_SKILLS_BRANCH,
} from "@vm0/core";

const SKILL_URL_PREFIX = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/`;

export function skillUrlToValue(url: string): string {
  if (url.startsWith(SKILL_URL_PREFIX)) {
    return url.slice(SKILL_URL_PREFIX.length);
  }
  return url;
}

/**
 * Static skills data for the multi-select combobox.
 * value = GitHub directory name (used in skill URL)
 * label = display name
 * icon  = external CDN URL
 */

function s(value: string, label: string, icon: string): ComboboxOption {
  return { value, label, icon };
}

export const skills$ = computed((): ComboboxOption[] => [
  s("axiom", "axiom", ""),
  s("brave-search", "brave-search", ""),
  s("discord", "discord", "https://cdn.simpleicons.org/discord"),
  s(
    "discord-webhook",
    "discord-webhook",
    "https://cdn.simpleicons.org/discord",
  ),
  s("figma", "figma", "https://cdn.simpleicons.org/figma"),
  s("firecrawl", "firecrawl", ""),
  s("github", "github", ""),
  s("github-copilot", "github-copilot", ""),
  s("gitlab", "gitlab", "https://cdn.simpleicons.org/gitlab"),
  s("gmail", "gmail", "https://cdn.simpleicons.org/gmail"),
  s(
    "google-sheets",
    "google-sheets",
    "https://cdn.simpleicons.org/googlesheets",
  ),
  s("intercom", "intercom", "https://cdn.simpleicons.org/intercom"),
  s("jira", "jira", "https://cdn.simpleicons.org/jira"),
  s("linear", "linear", "https://cdn.simpleicons.org/linear"),
  s("notion", "notion", ""),
  s(
    "openai",
    "openai",
    "https://upload.wikimedia.org/wikipedia/commons/e/ef/ChatGPT-Logo.svg",
  ),
  s("resend", "resend", "https://cdn.simpleicons.org/resend"),
  s("sentry", "sentry", "https://cdn.simpleicons.org/sentry"),
  s("slack", "slack", ""),
  s("slack-webhook", "slack-webhook", ""),
  s("supabase", "supabase", "https://cdn.simpleicons.org/supabase"),
  s("youtube", "youtube", "https://cdn.simpleicons.org/youtube"),
  s("zendesk", "zendesk", "https://cdn.simpleicons.org/zendesk"),
]);
