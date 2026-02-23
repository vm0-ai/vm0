import type { ComboboxOption } from "@vm0/ui";

const SKILL_URL_PREFIX = "https://github.com/vm0-ai/vm0-skills/tree/main/";

export function skillValueToUrl(value: string): string {
  return `${SKILL_URL_PREFIX}${value}`;
}

export function skillUrlToValue(url: string): string {
  if (url.startsWith(SKILL_URL_PREFIX)) {
    return url.slice(SKILL_URL_PREFIX.length);
  }
  // Fallback: extract last segment from any URL
  const parts = url.split("/");
  return parts[parts.length - 1] ?? url;
}

/**
 * Static skills data for the multi-select combobox.
 * Sourced from https://vm0.ai/api/web/skills — maintained manually.
 *
 * value = GitHub directory name (used in skill URL)
 * label = display name
 * icon  = absolute logo URL
 */
// eslint-disable-next-line ccstate/no-package-variable -- static readonly skills data
export const SKILLS: ComboboxOption[] = [
  // AI & Media
  {
    value: "elevenlabs",
    label: "elevenlabs",
    icon: "https://vm0.ai/skills/elevenlabs.svg",
  },
  {
    value: "fal.ai",
    label: "fal.ai",
    icon: "https://vm0.ai/skills/fal-image.svg",
  },
  {
    value: "htmlcsstoimage",
    label: "htmlcsstoimage",
    icon: "https://vm0.ai/skills/htmlcsstoimage.png",
  },
  {
    value: "openai",
    label: "openai",
    icon: "https://upload.wikimedia.org/wikipedia/commons/e/ef/ChatGPT-Logo.svg",
  },
  {
    value: "runway",
    label: "runway",
    icon: "https://vm0.ai/skills/runway.svg",
  },
  { value: "vm0-agent", label: "vm0-agent", icon: "https://vm0.ai/icon.svg" },
  { value: "vm0-cli", label: "vm0-cli", icon: "https://vm0.ai/icon.svg" },

  // Analytics
  { value: "axiom", label: "axiom", icon: "https://vm0.ai/skills/axiom.svg" },
  {
    value: "cronlytic",
    label: "cronlytic",
    icon: "https://vm0.ai/skills/cronlytic.png",
  },
  {
    value: "plausible",
    label: "plausible",
    icon: "https://vm0.ai/skills/plausible.svg",
  },
  {
    value: "reportei",
    label: "reportei",
    icon: "https://cdn.simpleicons.org/googleanalytics",
  },
  {
    value: "sentry",
    label: "sentry",
    icon: "https://cdn.simpleicons.org/sentry",
  },

  // Cloud Storage
  {
    value: "cloudinary",
    label: "cloudinary",
    icon: "https://vm0.ai/skills/cloudinary.svg",
  },
  { value: "minio", label: "minio", icon: "https://vm0.ai/skills/minio.svg" },
  {
    value: "qdrant",
    label: "qdrant",
    icon: "https://vm0.ai/skills/qdrant.svg",
  },
  {
    value: "supabase",
    label: "supabase",
    icon: "https://cdn.simpleicons.org/supabase",
  },
  {
    value: "supadata",
    label: "supadata",
    icon: "https://cdn.simpleicons.org/supabase",
  },

  // Communication
  {
    value: "agentmail",
    label: "agentmail",
    icon: "https://cdn.simpleicons.org/gmail",
  },
  {
    value: "chatwoot",
    label: "chatwoot",
    icon: "https://vm0.ai/skills/chatwoot.svg",
  },
  {
    value: "discord",
    label: "discord",
    icon: "https://cdn.simpleicons.org/discord",
  },
  {
    value: "discord-webhook",
    label: "discord-webhook",
    icon: "https://cdn.simpleicons.org/discord",
  },
  { value: "gmail", label: "gmail", icon: "https://cdn.simpleicons.org/gmail" },
  {
    value: "intercom",
    label: "intercom",
    icon: "https://cdn.simpleicons.org/intercom",
  },
  { value: "lark", label: "lark", icon: "https://vm0.ai/skills/lark.png" },
  {
    value: "mailsac",
    label: "mailsac",
    icon: "https://cdn.simpleicons.org/gmail",
  },
  {
    value: "pushinator",
    label: "pushinator",
    icon: "https://cdn.simpleicons.org/pushbullet",
  },
  {
    value: "resend",
    label: "resend",
    icon: "https://cdn.simpleicons.org/resend",
  },
  { value: "slack", label: "slack", icon: "https://vm0.ai/skills/slack.svg" },
  {
    value: "slack-webhook",
    label: "slack-webhook",
    icon: "https://vm0.ai/skills/slack.svg",
  },
  {
    value: "zendesk",
    label: "zendesk",
    icon: "https://cdn.simpleicons.org/zendesk",
  },
  {
    value: "zeptomail",
    label: "zeptomail",
    icon: "https://cdn.simpleicons.org/zoho",
  },

  // Content
  {
    value: "hackernews",
    label: "hackernews",
    icon: "https://cdn.simpleicons.org/ycombinator",
  },
  { value: "imgur", label: "imgur", icon: "https://vm0.ai/skills/imgur.svg" },
  {
    value: "instagram",
    label: "instagram",
    icon: "https://vm0.ai/skills/instagram.svg",
  },
  {
    value: "podchaser",
    label: "podchaser",
    icon: "https://cdn.simpleicons.org/applepodcasts",
  },
  { value: "qiita", label: "qiita", icon: "https://vm0.ai/skills/qiita.svg" },
  {
    value: "youtube",
    label: "youtube",
    icon: "https://cdn.simpleicons.org/youtube",
  },

  // Development
  {
    value: ".claude",
    label: "Claude Config",
    icon: "https://cdn.simpleicons.org/anthropic",
  },
  {
    value: ".claude-plugin",
    label: "Claude Plugin",
    icon: "https://cdn.simpleicons.org/anthropic",
  },
  {
    value: "deepseek",
    label: "deepseek",
    icon: "https://vm0.ai/skills/deepseek.svg",
  },
  {
    value: "dev.to",
    label: "dev.to",
    icon: "https://cdn.simpleicons.org/devdotto",
  },
  {
    value: "github",
    label: "github",
    icon: "https://vm0.ai/skills/github.svg",
  },
  {
    value: "github-copilot",
    label: "github-copilot",
    icon: "https://vm0.ai/skills/githubcopilot.svg",
  },
  {
    value: "gitlab",
    label: "gitlab",
    icon: "https://cdn.simpleicons.org/gitlab",
  },
  { value: "vm0", label: "VM0", icon: "https://vm0.ai/icon.svg" },
  { value: ".vm0", label: "VM0 Config", icon: "https://vm0.ai/icon.svg" },

  // Documents
  {
    value: "pdf4me",
    label: "pdf4me",
    icon: "https://vm0.ai/skills/pdf4me.svg",
  },
  { value: "pdfco", label: "pdfco", icon: "https://vm0.ai/skills/pdfco.svg" },
  {
    value: "pdforge",
    label: "pdforge",
    icon: "https://vm0.ai/skills/pdforge.svg",
  },
  {
    value: "zapsign",
    label: "zapsign",
    icon: "https://vm0.ai/skills/zapsign.svg",
  },

  // Other
  {
    value: "cloudflare-tunnel",
    label: "cloudflare-tunnel",
    icon: "https://cdn.simpleicons.org/cloudflare",
  },
  {
    value: "pikvm",
    label: "pikvm",
    icon: "https://cdn.simpleicons.org/raspberrypi",
  },
  {
    value: "vm0-computer",
    label: "vm0-computer",
    icon: "https://vm0.ai/icon.svg",
  },

  // Productivity
  {
    value: "bitrix",
    label: "bitrix",
    icon: "https://vm0.ai/skills/bitrix.svg",
  },
  { value: "figma", label: "figma", icon: "https://cdn.simpleicons.org/figma" },
  {
    value: "google-sheets",
    label: "google-sheets",
    icon: "https://cdn.simpleicons.org/googlesheets",
  },
  {
    value: "instantly",
    label: "instantly",
    icon: "https://cdn.simpleicons.org/maildotru",
  },
  { value: "jira", label: "jira", icon: "https://cdn.simpleicons.org/jira" },
  { value: "kommo", label: "kommo", icon: "https://vm0.ai/skills/kommo.webp" },
  {
    value: "linear",
    label: "linear",
    icon: "https://cdn.simpleicons.org/linear",
  },
  {
    value: "monday",
    label: "monday",
    icon: "https://vm0.ai/skills/monday.svg",
  },
  {
    value: "notion",
    label: "notion",
    icon: "https://vm0.ai/skills/notion.svg",
  },
  {
    value: "streak",
    label: "streak",
    icon: "https://cdn.simpleicons.org/gmail",
  },
  {
    value: "twenty",
    label: "twenty",
    icon: "https://cdn.simpleicons.org/airtable",
  },
  {
    value: "workflow-migration",
    label: "workflow-migration",
    icon: "https://cdn.simpleicons.org/zapier",
  },

  // Search
  {
    value: "brave-search",
    label: "brave-search",
    icon: "https://vm0.ai/skills/brave.svg",
  },
  {
    value: "perplexity",
    label: "perplexity",
    icon: "https://vm0.ai/skills/perplexity.svg",
  },
  {
    value: "rss-fetch",
    label: "rss-fetch",
    icon: "https://vm0.ai/skills/rss.svg",
  },
  {
    value: "serpapi",
    label: "serpapi",
    icon: "https://vm0.ai/skills/serpapi.png",
  },
  {
    value: "tavily",
    label: "tavily",
    icon: "https://vm0.ai/skills/tavily.svg",
  },

  // Utilities
  {
    value: "minimax",
    label: "minimax",
    icon: "https://vm0.ai/skills/minimax.svg",
  },
  {
    value: "shortio",
    label: "shortio",
    icon: "https://cdn.simpleicons.org/bitly",
  },

  // Web Scraping
  { value: "apify", label: "apify", icon: "https://vm0.ai/skills/apify.svg" },
  {
    value: "bright-data",
    label: "bright-data",
    icon: "https://vm0.ai/skills/bright-data.png",
  },
  {
    value: "browserbase",
    label: "browserbase",
    icon: "https://cdn.simpleicons.org/googlechrome",
  },
  {
    value: "browserless",
    label: "browserless",
    icon: "https://vm0.ai/skills/browserless.png",
  },
  {
    value: "firecrawl",
    label: "firecrawl",
    icon: "https://vm0.ai/skills/firecrawl.svg",
  },
  {
    value: "mercury",
    label: "mercury",
    icon: "https://cdn.simpleicons.org/mercury",
  },
  {
    value: "scrapeninja",
    label: "scrapeninja",
    icon: "https://vm0.ai/skills/scrapeninja.svg",
  },
];
