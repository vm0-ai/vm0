import { computed } from "ccstate";
import type { ComboboxOption } from "@vm0/ui";

const SKILL_URL_PREFIX = "https://github.com/vm0-ai/vm0-skills/tree/main/";

export function skillValueToUrl(value: string): string {
  return `${SKILL_URL_PREFIX}${value}`;
}

export function skillUrlToValue(url: string): string {
  if (url.startsWith(SKILL_URL_PREFIX)) {
    return url.slice(SKILL_URL_PREFIX.length);
  }
  return url;
}

/**
 * Static skills data for the multi-select combobox.
 * Sourced from https://vm0.ai/api/web/skills — maintained manually.
 *
 * value = GitHub directory name (used in skill URL)
 * label = display name
 * icon  = absolute logo URL
 */

function s(value: string, label: string, icon: string): ComboboxOption {
  return { value, label, icon };
}

function aiMediaSkills(): ComboboxOption[] {
  return [
    s("elevenlabs", "elevenlabs", "https://vm0.ai/skills/elevenlabs.svg"),
    s("fal.ai", "fal.ai", "https://vm0.ai/skills/fal-image.svg"),
    s(
      "htmlcsstoimage",
      "htmlcsstoimage",
      "https://vm0.ai/skills/htmlcsstoimage.png",
    ),
    s(
      "openai",
      "openai",
      "https://upload.wikimedia.org/wikipedia/commons/e/ef/ChatGPT-Logo.svg",
    ),
    s("runway", "runway", "https://vm0.ai/skills/runway.svg"),
    s("vm0-agent", "vm0-agent", "https://vm0.ai/icon.svg"),
    s("vm0-cli", "vm0-cli", "https://vm0.ai/icon.svg"),
  ];
}

function analyticsSkills(): ComboboxOption[] {
  return [
    s("axiom", "axiom", "https://vm0.ai/skills/axiom.svg"),
    s("cronlytic", "cronlytic", "https://vm0.ai/skills/cronlytic.png"),
    s("plausible", "plausible", "https://vm0.ai/skills/plausible.svg"),
    s("reportei", "reportei", "https://cdn.simpleicons.org/googleanalytics"),
    s("sentry", "sentry", "https://cdn.simpleicons.org/sentry"),
  ];
}

function cloudStorageSkills(): ComboboxOption[] {
  return [
    s("cloudinary", "cloudinary", "https://vm0.ai/skills/cloudinary.svg"),
    s("minio", "minio", "https://vm0.ai/skills/minio.svg"),
    s("qdrant", "qdrant", "https://vm0.ai/skills/qdrant.svg"),
    s("supabase", "supabase", "https://cdn.simpleicons.org/supabase"),
    s("supadata", "supadata", "https://cdn.simpleicons.org/supabase"),
  ];
}

function communicationSkills(): ComboboxOption[] {
  return [
    s("agentmail", "agentmail", "https://cdn.simpleicons.org/gmail"),
    s("chatwoot", "chatwoot", "https://vm0.ai/skills/chatwoot.svg"),
    s("discord", "discord", "https://cdn.simpleicons.org/discord"),
    s(
      "discord-webhook",
      "discord-webhook",
      "https://cdn.simpleicons.org/discord",
    ),
    s("gmail", "gmail", "https://cdn.simpleicons.org/gmail"),
    s("intercom", "intercom", "https://cdn.simpleicons.org/intercom"),
    s("lark", "lark", "https://vm0.ai/skills/lark.png"),
    s("mailsac", "mailsac", "https://cdn.simpleicons.org/gmail"),
    s("pushinator", "pushinator", "https://cdn.simpleicons.org/pushbullet"),
    s("resend", "resend", "https://cdn.simpleicons.org/resend"),
    s("slack", "slack", "https://vm0.ai/skills/slack.svg"),
    s("slack-webhook", "slack-webhook", "https://vm0.ai/skills/slack.svg"),
    s("zendesk", "zendesk", "https://cdn.simpleicons.org/zendesk"),
    s("zeptomail", "zeptomail", "https://cdn.simpleicons.org/zoho"),
  ];
}

function contentSkills(): ComboboxOption[] {
  return [
    s("hackernews", "hackernews", "https://cdn.simpleicons.org/ycombinator"),
    s("imgur", "imgur", "https://vm0.ai/skills/imgur.svg"),
    s("instagram", "instagram", "https://vm0.ai/skills/instagram.svg"),
    s("podchaser", "podchaser", "https://cdn.simpleicons.org/applepodcasts"),
    s("qiita", "qiita", "https://vm0.ai/skills/qiita.svg"),
    s("youtube", "youtube", "https://cdn.simpleicons.org/youtube"),
  ];
}

function developmentSkills(): ComboboxOption[] {
  return [
    s(".claude", "Claude Config", "https://cdn.simpleicons.org/anthropic"),
    s(
      ".claude-plugin",
      "Claude Plugin",
      "https://cdn.simpleicons.org/anthropic",
    ),
    s("deepseek", "deepseek", "https://vm0.ai/skills/deepseek.svg"),
    s("dev.to", "dev.to", "https://cdn.simpleicons.org/devdotto"),
    s("github", "github", "https://vm0.ai/skills/github.svg"),
    s(
      "github-copilot",
      "github-copilot",
      "https://vm0.ai/skills/githubcopilot.svg",
    ),
    s("gitlab", "gitlab", "https://cdn.simpleicons.org/gitlab"),
    s("vm0", "VM0", "https://vm0.ai/icon.svg"),
    s(".vm0", "VM0 Config", "https://vm0.ai/icon.svg"),
  ];
}

function documentSkills(): ComboboxOption[] {
  return [
    s("pdf4me", "pdf4me", "https://vm0.ai/skills/pdf4me.svg"),
    s("pdfco", "pdfco", "https://vm0.ai/skills/pdfco.svg"),
    s("pdforge", "pdforge", "https://vm0.ai/skills/pdforge.svg"),
    s("zapsign", "zapsign", "https://vm0.ai/skills/zapsign.svg"),
  ];
}

function otherSkills(): ComboboxOption[] {
  return [
    s(
      "cloudflare-tunnel",
      "cloudflare-tunnel",
      "https://cdn.simpleicons.org/cloudflare",
    ),
    s("pikvm", "pikvm", "https://cdn.simpleicons.org/raspberrypi"),
    s("vm0-computer", "vm0-computer", "https://vm0.ai/icon.svg"),
  ];
}

function productivitySkills(): ComboboxOption[] {
  return [
    s("bitrix", "bitrix", "https://vm0.ai/skills/bitrix.svg"),
    s("figma", "figma", "https://cdn.simpleicons.org/figma"),
    s(
      "google-sheets",
      "google-sheets",
      "https://cdn.simpleicons.org/googlesheets",
    ),
    s("instantly", "instantly", "https://cdn.simpleicons.org/maildotru"),
    s("jira", "jira", "https://cdn.simpleicons.org/jira"),
    s("kommo", "kommo", "https://vm0.ai/skills/kommo.webp"),
    s("linear", "linear", "https://cdn.simpleicons.org/linear"),
    s("monday", "monday", "https://vm0.ai/skills/monday.svg"),
    s("notion", "notion", "https://vm0.ai/skills/notion.svg"),
    s("streak", "streak", "https://cdn.simpleicons.org/gmail"),
    s("twenty", "twenty", "https://cdn.simpleicons.org/airtable"),
    s(
      "workflow-migration",
      "workflow-migration",
      "https://cdn.simpleicons.org/zapier",
    ),
  ];
}

function searchSkills(): ComboboxOption[] {
  return [
    s("brave-search", "brave-search", "https://vm0.ai/skills/brave.svg"),
    s("perplexity", "perplexity", "https://vm0.ai/skills/perplexity.svg"),
    s("rss-fetch", "rss-fetch", "https://vm0.ai/skills/rss.svg"),
    s("serpapi", "serpapi", "https://vm0.ai/skills/serpapi.png"),
    s("tavily", "tavily", "https://vm0.ai/skills/tavily.svg"),
  ];
}

function utilitySkills(): ComboboxOption[] {
  return [
    s("minimax", "minimax", "https://vm0.ai/skills/minimax.svg"),
    s("shortio", "shortio", "https://cdn.simpleicons.org/bitly"),
  ];
}

function webScrapingSkills(): ComboboxOption[] {
  return [
    s("apify", "apify", "https://vm0.ai/skills/apify.svg"),
    s("bright-data", "bright-data", "https://vm0.ai/skills/bright-data.png"),
    s("browserbase", "browserbase", "https://cdn.simpleicons.org/googlechrome"),
    s("browserless", "browserless", "https://vm0.ai/skills/browserless.png"),
    s("firecrawl", "firecrawl", "https://vm0.ai/skills/firecrawl.svg"),
    s("mercury", "mercury", "https://vm0.ai/skills/mercury.svg"),
    s("scrapeninja", "scrapeninja", "https://vm0.ai/skills/scrapeninja.svg"),
  ];
}

export const skills$ = computed((): ComboboxOption[] => [
  ...aiMediaSkills(),
  ...analyticsSkills(),
  ...cloudStorageSkills(),
  ...communicationSkills(),
  ...contentSkills(),
  ...developmentSkills(),
  ...documentSkills(),
  ...otherSkills(),
  ...productivitySkills(),
  ...searchSkills(),
  ...utilitySkills(),
  ...webScrapingSkills(),
]);
