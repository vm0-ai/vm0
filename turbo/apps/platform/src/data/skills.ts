import { computed } from "ccstate";
import type { ComboboxOption } from "@vm0/ui";
import {
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
  DEFAULT_SKILLS_BRANCH,
} from "@vm0/core";
import { SKILL_ICONS } from "../views/zero-page/components/settings/skill-icons.ts";

const SKILL_URL_PREFIX = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/`;

export function skillUrlToValue(url: string): string {
  if (url.startsWith(SKILL_URL_PREFIX)) {
    return url.slice(SKILL_URL_PREFIX.length);
  }
  return url;
}

/**
 * Static skills data for the multi-select combobox.
 * Maintained manually.
 *
 * value = GitHub directory name (used in skill URL)
 * label = display name
 * icon  = bundled asset URL (via SKILL_ICONS) or external CDN URL
 */

function s(value: string, label: string, icon: string): ComboboxOption {
  return { value, label, icon };
}

function aiMediaSkills(): ComboboxOption[] {
  return [
    s("elevenlabs", "elevenlabs", SKILL_ICONS["elevenlabs"] ?? ""),
    s("fal", "fal", SKILL_ICONS["fal"] ?? ""),
    s("htmlcsstoimage", "htmlcsstoimage", SKILL_ICONS["htmlcsstoimage"] ?? ""),
    s(
      "openai",
      "openai",
      "https://upload.wikimedia.org/wikipedia/commons/e/ef/ChatGPT-Logo.svg",
    ),
    s("runway", "runway", SKILL_ICONS["runway"] ?? ""),
    s("vm0-agent", "vm0-agent", SKILL_ICONS["vm0-agent"] ?? ""),
    s("vm0-cli", "vm0-cli", SKILL_ICONS["vm0-cli"] ?? ""),
  ];
}

function analyticsSkills(): ComboboxOption[] {
  return [
    s(
      "axiom",
      "axiom",
      "data:image/svg+xml,%3Csvg width='68' height='60' viewBox='0 0 17 15' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M16.5089 10.1066L13.0911 4.31803C12.9344 4.05199 12.5482 3.83432 12.2329 3.83432H10.0991C9.60314 3.83432 9.39981 3.49237 9.64721 3.07442L10.8173 1.0978C10.9102 0.940926 10.91 0.747804 10.8168 0.5911C10.7236 0.434397 10.5516 0.337891 10.3655 0.337891H7.38875C7.07344 0.337891 6.68637 0.555072 6.52858 0.820524L0.744369 10.5524C0.586609 10.8178 0.586487 11.2522 0.744156 11.5177L2.23248 14.0243C2.48046 14.442 2.88713 14.4425 3.13616 14.0254L4.29915 12.0781C4.54819 11.661 4.95486 11.6615 5.20283 12.0792L6.25715 13.8548C6.41479 14.1203 6.80177 14.3376 7.11707 14.3376H13.9955C14.3109 14.3376 14.6978 14.1203 14.8555 13.8548L16.5072 11.0731C16.6649 10.8075 16.6656 10.3726 16.5089 10.1066ZM11.8932 9.828C12.1396 10.2465 11.9355 10.5889 11.4395 10.5889H6.08915C5.5932 10.5889 5.39029 10.2472 5.63826 9.82956L8.31555 5.32067C8.56352 4.90304 8.96929 4.90305 9.21723 5.3207L11.8932 9.828Z' fill='%2309101F'/%3E%3C/svg%3E",
    ),
    s("cronlytic", "cronlytic", SKILL_ICONS["cronlytic"] ?? ""),
    s("plausible", "plausible", SKILL_ICONS["plausible"] ?? ""),
    s("reportei", "reportei", "https://cdn.simpleicons.org/googleanalytics"),
    s("sentry", "sentry", "https://cdn.simpleicons.org/sentry"),
  ];
}

function cloudStorageSkills(): ComboboxOption[] {
  return [
    s("cloudinary", "cloudinary", SKILL_ICONS["cloudinary"] ?? ""),
    s("minio", "minio", SKILL_ICONS["minio"] ?? ""),
    s("qdrant", "qdrant", SKILL_ICONS["qdrant"] ?? ""),
    s("supabase", "supabase", "https://cdn.simpleicons.org/supabase"),
    s("supadata", "supadata", "https://cdn.simpleicons.org/supabase"),
  ];
}

function communicationSkills(): ComboboxOption[] {
  return [
    s("agentmail", "agentmail", "https://cdn.simpleicons.org/gmail"),
    s("chatwoot", "chatwoot", SKILL_ICONS["chatwoot"] ?? ""),
    s("discord", "discord", "https://cdn.simpleicons.org/discord"),
    s(
      "discord-webhook",
      "discord-webhook",
      "https://cdn.simpleicons.org/discord",
    ),
    s("gmail", "gmail", "https://cdn.simpleicons.org/gmail"),
    s("intercom", "intercom", "https://cdn.simpleicons.org/intercom"),
    s("lark", "lark", SKILL_ICONS["lark"] ?? ""),
    s("mailsac", "mailsac", "https://cdn.simpleicons.org/gmail"),
    s("pushinator", "pushinator", "https://cdn.simpleicons.org/pushbullet"),
    s("resend", "resend", "https://cdn.simpleicons.org/resend"),
    s("slack", "slack", SKILL_ICONS["slack"] ?? ""),
    s("slack-webhook", "slack-webhook", SKILL_ICONS["slack-webhook"] ?? ""),
    s("zendesk", "zendesk", "https://cdn.simpleicons.org/zendesk"),
    s("zeptomail", "zeptomail", "https://cdn.simpleicons.org/zoho"),
  ];
}

function contentSkills(): ComboboxOption[] {
  return [
    s("hackernews", "hackernews", "https://cdn.simpleicons.org/ycombinator"),
    s("imgur", "imgur", SKILL_ICONS["imgur"] ?? ""),
    s("instagram", "instagram", SKILL_ICONS["instagram"] ?? ""),
    s("podchaser", "podchaser", "https://cdn.simpleicons.org/applepodcasts"),
    s("qiita", "qiita", SKILL_ICONS["qiita"] ?? ""),
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
    s("deepseek", "deepseek", SKILL_ICONS["deepseek"] ?? ""),
    s("devto", "devto", SKILL_ICONS["devto"] ?? ""),
    s("github", "github", SKILL_ICONS["github"] ?? ""),
    s("github-copilot", "github-copilot", SKILL_ICONS["github-copilot"] ?? ""),
    s("gitlab", "gitlab", "https://cdn.simpleicons.org/gitlab"),
    s("vm0", "VM0", SKILL_ICONS["vm0"] ?? ""),
    s(".vm0", "VM0 Config", SKILL_ICONS[".vm0"] ?? ""),
  ];
}

function documentSkills(): ComboboxOption[] {
  return [
    s("pdf4me", "pdf4me", SKILL_ICONS["pdf4me"] ?? ""),
    s("pdfco", "pdfco", SKILL_ICONS["pdfco"] ?? ""),
    s("pdforge", "pdforge", SKILL_ICONS["pdforge"] ?? ""),
    s("zapsign", "zapsign", SKILL_ICONS["zapsign"] ?? ""),
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
    s("vm0-computer", "vm0-computer", SKILL_ICONS["vm0-computer"] ?? ""),
  ];
}

function productivitySkills(): ComboboxOption[] {
  return [
    s("bitrix", "bitrix", SKILL_ICONS["bitrix"] ?? ""),
    s("clickup", "clickup", "https://cdn.simpleicons.org/clickup"),
    s("figma", "figma", "https://cdn.simpleicons.org/figma"),
    s(
      "google-sheets",
      "google-sheets",
      "https://cdn.simpleicons.org/googlesheets",
    ),
    s("instantly", "instantly", "https://cdn.simpleicons.org/maildotru"),
    s("jira", "jira", "https://cdn.simpleicons.org/jira"),
    s("kommo", "kommo", SKILL_ICONS["kommo"] ?? ""),
    s("linear", "linear", "https://cdn.simpleicons.org/linear"),
    s("monday", "monday", SKILL_ICONS["monday"] ?? ""),
    s("notion", "notion", SKILL_ICONS["notion"] ?? ""),
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
    s("brave-search", "brave-search", SKILL_ICONS["brave-search"] ?? ""),
    s("perplexity", "perplexity", SKILL_ICONS["perplexity"] ?? ""),
    s("rss-fetch", "rss-fetch", SKILL_ICONS["rss-fetch"] ?? ""),
    s("serpapi", "serpapi", SKILL_ICONS["serpapi"] ?? ""),
    s("tavily", "tavily", SKILL_ICONS["tavily"] ?? ""),
  ];
}

function utilitySkills(): ComboboxOption[] {
  return [
    s("minimax", "minimax", SKILL_ICONS["minimax"] ?? ""),
    s("shortio", "shortio", "https://cdn.simpleicons.org/bitly"),
  ];
}

function webScrapingSkills(): ComboboxOption[] {
  return [
    s("apify", "apify", SKILL_ICONS["apify"] ?? ""),
    s("bright-data", "bright-data", SKILL_ICONS["bright-data"] ?? ""),
    s("browserbase", "browserbase", "https://cdn.simpleicons.org/googlechrome"),
    s("browserless", "browserless", SKILL_ICONS["browserless"] ?? ""),
    s("firecrawl", "firecrawl", SKILL_ICONS["firecrawl"] ?? ""),
    s(
      "mercury",
      "mercury",
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Cpath d='M23.9473,15.9296872c0-1.1955996.8087997-2.0044003,2.0394993-2.0044003,1.1253014,0,1.898901.8088007,1.898901,2.0044003,0,1.1603994-.7735996,1.934001-1.898901,1.934001-1.2306995,0-2.0394993-.7736015-2.0394993-1.934001ZM20.9230995,9.6703173c.7033005-1.0197697,1.1604004-2.2505503,1.1604004-3.9736099,1.7231007,1.0197797,3.1648006,2.4615002,4.1846008,4.1846094-1.6879005,0-2.9187012.4570704-3.9384003,1.19557-.3868999-.5274992-.8791008-1.0196991-1.406601-1.4065695ZM20.8526993,22.2592875c.5275002-.3866997.9847012-.8791008,1.406601-1.3714008,1.0198002.7737007,2.285799,1.2308006,4.0088005,1.2308006-1.0198002,1.7581997-2.4615002,3.2000008-4.1846008,4.1846008,0-1.7582016-.4570999-3.0242004-1.2308006-4.0440006ZM19.7978001,1.3714173c6.5757999,1.6527499,11.287899,7.4901298,11.287899,14.62857,0,2.9890003-2.2504997,5.2043991-5.169199,5.2043991-1.1956005,0-2.3209-.3867989-3.1648006-1.0197983.4570999-.7384014.7735996-1.5472012.9846001-2.4264011.5626011.6329994,1.3714008,1.0198002,2.2504997,1.0198002,1.5121002,0,2.8132-1.3010998,2.8132-2.8483,0-4.8879004-2.8132-9.17803-6.9273987-11.3231101-.3164997-1.2659297-1.0902004-2.4263699-2.0748005-3.2351598ZM18.1450996,20.1845881c1.5121002-.7736015,2.5669994-2.3560009,2.5669994-4.1846008,0-3.4462004,3.0593014-5.6967001,6.0835018-5.1341.3867989.8439999.6680984,1.7933998.8790989,2.7428999-.4923-.3867998-1.0548992-.5978003-1.6879005-.5978003-1.6175995,0-2.9538994,1.3362999-2.9538994,2.9187002,0,2.3912001-1.0900993,4.4306993-2.7427998,5.6967001-.5977993-.6329994-1.3362999-1.1252995-2.1450005-1.4417992ZM14.0307999,6.1186573c0-1.19559.8087997-2.0043898,2.0394993-2.0043898,1.1253014,0,1.898901.8087997,1.898901,2.0043898,0,1.16044-.7735996,1.9340501-1.898901,1.9340501-1.2306995,0-2.0394993-.7736101-2.0394993-1.9340501ZM14.0307999,25.9516875c0-1.1956005.8087997-2.0044003,2.0394993-2.0044003,1.1253014,0,1.898901.8087997,1.898901,2.0044003,0,1.1604004-.7735996,1.934-1.898901,1.934-1.2306995,0-2.0394993-.7735996-2.0394993-1.934ZM12.2021999,15.9999873c0-2.1801996,1.6176004-3.7978001,3.8330002-3.7978001,2.1802006,0,3.7625999,1.6176004,3.7625999,3.7978001,0,2.2154007-1.5823994,3.7978001-3.7625999,3.7978001-2.2153997,0-3.8330002-1.5823994-3.8330002-3.7978001ZM16.0352001,11.2878872c-3.3759003,0-5.6264-2.81318-5.1341-6.0483398.8790998-.4219799,1.8636999-.7384601,2.8483-.91429-.3867998.49231-.6329002,1.1252899-.6329002,1.7933998,0,1.5472698,1.3361998,2.8483901,2.9537992,2.8483901,2.3561001,0,4.3956013.9846096,5.6264,2.6373396-.6680984.6330004-1.1603985,1.4066-1.5120983,2.2505007-.7736015-1.5121002-2.3560009-2.5670004-4.1494007-2.5670004ZM10.8308001,25.8812872c0-1.1956005.3867998-2.2856998,1.0198002-3.1296005.7031994.4218998,1.4769001.7735996,2.3207998.9846001-.6330004.527401-1.0549002,1.3362999-1.0549002,2.2154007,0,1.5471992,1.3361998,2.848299,2.9537992,2.848299,4.9231014,0,9.1429005-2.7779999,11.2528-6.8571987,1.3011017-.3164005,2.4615002-1.0549011,3.2702999-2.0747013-1.6526985,6.5407009-7.4549999,11.2175999-14.593399,11.2175999-2.9187002,0-5.1691999-2.2504997-5.1691999-5.2043991ZM10.4088001,20.3252875c.5978003-.6329994,1.0901003-1.3715,1.4066-2.1802006.7735996,1.5121002,2.3912001,2.5669994,4.2198,2.5669994,3.3757992,0,5.5911999,2.9890003,5.0636997,6.1187-.8790989.3868008-1.8285999.7033005-2.8132.8791008.3516998-.4923.5977993-1.0900993.5977993-1.7581997,0-1.5825005-1.3010998-2.9188004-2.8132-2.9188004-2.355999,0-4.3955994-1.0548992-5.661499-2.7075996ZM5.7670598,22.1186873c1.68788,0,2.9538302-.4570999,3.9736104-1.2308006.4219294.4923.8791294.9847012,1.4066296,1.3714008-.7736998,1.0198002-1.2307997,2.285799-1.2307997,4.0088005-1.7231102-1.0198002-3.1296701-2.4263-4.1494403-4.1494007ZM5.7318902,9.8813168c1.0197797-1.6879396,2.4614997-3.1296597,4.1846099-4.1494393,0,1.7582197.4570999,3.0241694,1.2658997,4.0439401-.5275002.3867693-1.0198002.8439693-1.4065695,1.3714695-1.0197706-.8088999-2.2857203-1.2659702-4.0439401-1.2659702ZM4.2901101,18.1450869c.5274701.3868008,1.16044.6329002,1.8637199.6329002,1.5121098,0,2.81323-1.3010998,2.81323-2.8483,0-2.2858,1.0901403-4.2550001,2.7428398-5.5208998.6329002.5978003,1.3713999,1.0901003,2.1801996,1.4066-1.5472994.7735996-2.6021996,2.3912001-2.6021996,4.1845999,0,3.4461994-2.9186802,5.6264-6.0483398,5.1341-.4219799-.9494991-.7384601-1.9340992-.94945-2.9890003ZM4.1142802,15.9296872c0-1.1955996.8087997-2.0044003,2.0395498-2.0044003,1.1252799,0,1.89889.8088007,1.89889,2.0044003,0,1.1603994-.7736101,1.934001-1.89889,1.934001-1.2307501,0-2.0395498-.7736015-2.0395498-1.934001ZM1.37143,12.1670872C3.05934,5.5912072,8.8615599.9142702,15.9647999.9142702c2.9538994,0,5.204401,2.250547,5.204401,5.1692169,0,1.19561-.3516006,2.2505598-.9493999,3.0945005-.7033005-.4219408-1.4770012-.7384405-2.3209019-.9142809.5978012-.5274396.9846001-1.3011098.9846001-2.1450496,0-1.5823998-1.3010998-2.9186699-2.8132-2.9186699-4.9581995,0-9.2482991,2.8131697-11.3933792,6.8572004-1.3011.3163996-2.46154,1.0900993-3.3054899,2.1098995ZM.914283,15.9999873c0-2.9538002,2.250547-5.2044001,5.204387-5.2044001,1.19561,0,2.2857203.3867998,3.1296601,1.0550003-.4219398.6680994-.7384405,1.4066-.94944,2.2152996-.5274501-.6329994-1.3011103-1.0549002-2.1450601-1.0549002-1.6175599,0-2.95383,1.3362999-2.95383,2.9187002,0,4.9933996,2.7780001,9.2482996,6.8923004,11.4285002.3164997,1.3010998,1.0900993,2.4263992,2.1098995,3.2703991C5.62639,29.0109869.914283,23.1735865.914283,15.9999873ZM15.9647999,31.9999873c8.5450993,0,16.0352001-6.8220005,16.0352001-16C32,7.1384274,24.8616009-.0000127,15.9647999-.0000127,7.1384401-.0000127,0,7.1384274,0,15.9999873c0,8.8616009,7.1384401,16,15.9647999,16Z'/%3E%3C/svg%3E",
    ),
    s("scrapeninja", "scrapeninja", SKILL_ICONS["scrapeninja"] ?? ""),
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
