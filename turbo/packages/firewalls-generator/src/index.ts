/**
 * Firewall config generator entry point.
 *
 * Usage:
 *   tsx src/index.ts           # generate all
 *   tsx src/index.ts github    # generate github only
 */

import { generate as generateAgentmail } from "./agentmail";
import { generate as generateAmplitude } from "./amplitude";
import { generate as generateAnthropicManagedAgents } from "./anthropic-managed-agents";
import { generate as generateAhrefs } from "./ahrefs";
import { generate as generateAgora } from "./agora";
import { generate as generateAirtable } from "./airtable";
import { generate as generateApollo } from "./apollo";
import { generate as generateApify } from "./apify";
import { generate as generateAsana } from "./asana";
import { generate as generateAttio } from "./attio";
import { generate as generateAtlassian } from "./atlassian";
import { generate as generateAtlascloud } from "./atlascloud";
import { generate as generateAviationstack } from "./aviationstack";
import { generate as generateAxiom } from "./axiom";
import { generate as generateBase44 } from "./base44";
import { generate as generateBentoml } from "./bentoml";
import { generate as generateBitrix } from "./bitrix";
import { generate as generateBraveSearch } from "./brave-search";
import { generate as generateBrex } from "./brex";
import { generate as generateBrevo } from "./brevo";
import { generate as generateBrightData } from "./bright-data";
import { generate as generateBrowserbase } from "./browserbase";
import { generate as generateBrowserUse } from "./browser-use";
import { generate as generateBrowserless } from "./browserless";
import { generate as generateBuffer } from "./buffer";
import { generate as generateBuiltwith } from "./builtwith";
import { generate as generateCalCom } from "./cal-com";
import { generate as generateCalendly } from "./calendly";
import { generate as generateCanva } from "./canva";
import { generate as generateChatwoot } from "./chatwoot";
import { generate as generateCheckr } from "./checkr";
import { generate as generateClado } from "./clado";
import { generate as generateClickup } from "./clickup";
import { generate as generateClose } from "./close";
import { generate as generateClerk } from "./clerk";
import { generate as generateCloudflare } from "./cloudflare";
import { generate as generateCoda } from "./coda";
import { generate as generateCoresignal } from "./coresignal";
import { generate as generateCronlytic } from "./cronlytic";
import { generate as generateCustomerIo } from "./customer-io";
import { generate as generateDeepseek } from "./deepseek";
import { generate as generateDoubao } from "./doubao";
import { generate as generateDeel } from "./deel";
import { generate as generateDevto } from "./devto";
import { generate as generateDiffbot } from "./diffbot";
import { generate as generateDify } from "./dify";
import { generate as generateDoppler } from "./doppler";
import { generate as generateDiscord } from "./discord";
import { generate as generateDiscordWebhook } from "./discord-webhook";
import { generate as generateDocusign } from "./docusign";
import { generate as generateDb9 } from "./db9";
import { generate as generateDrive9 } from "./drive9";
import { generate as generateDropbox } from "./dropbox";
import { generate as generateDropboxSign } from "./dropbox-sign";
import { generate as generateDuffel } from "./duffel";
import { generate as generateE2b } from "./e2b";
import { generate as generateElevenlabs } from "./elevenlabs";
import { generate as generateEtsy } from "./etsy";
import { generate as generateExa } from "./exa";
import { generate as generateExplorium } from "./explorium";
import { generate as generateFaire } from "./faire";
import { generate as generateFal } from "./fal";
import { generate as generateFigma } from "./figma";
import { generate as generateFirecrawl } from "./firecrawl";
import { generate as generateFireflies } from "./fireflies";
import { generate as generateFreshdesk } from "./freshdesk";
import { generate as generateGamma } from "./gamma";
import { generate as generateGarminConnect } from "./garmin-connect";
import { generate as generateGemini } from "./gemini";
import { generate as generateGitHub } from "./github";
import { generate as generateGitlab } from "./gitlab";
import { generate as generateGranola } from "./granola";
import { generate as generateGreenhouse } from "./greenhouse";
import { generate as generateGroq } from "./groq";
import { generate as generateGumroad } from "./gumroad";
import { generate as generateHeygen } from "./heygen";
import { generate as generateHelicone } from "./helicone";
import { generate as generateHtmlcsstoimage } from "./htmlcsstoimage";
import { generate as generateHubspot } from "./hubspot";
import { generate as generateHuggingFace } from "./hugging-face";
import { generate as generateHume } from "./hume";
import { generate as generateHunter } from "./hunter";
import { generate as generateImgur } from "./imgur";
import { generate as generateInfisical } from "./infisical";
import { generate as generateInstagram } from "./instagram";
import { generate as generateInstantly } from "./instantly";
import { generate as generateIntercom } from "./intercom";
import { generate as generateIntervalsIcu } from "./intervals-icu";
import { generate as generateJam } from "./jam";
import { generate as generateJira } from "./jira";
import { generate as generateJotform } from "./jotform";
import { generate as generateKlaviyo } from "./klaviyo";
import { generate as generateKommo } from "./kommo";
import { generate as generateLark } from "./lark";
import { generate as generateLangfuse } from "./langfuse";
import { generate as generateLangsmith } from "./langsmith";
import { generate as generateLine } from "./line";
import { generate as generateLinear } from "./linear";
import { generate as generateLoops } from "./loops";
import { generate as generateLuma } from "./luma";
import { generate as generateLumaAi } from "./luma-ai";
import { generate as generateMailchimp } from "./mailchimp";
import { generate as generateMake } from "./make";
import { generate as generateMailsac } from "./mailsac";
import { generate as generateManus } from "./manus";
import { generate as generateMapbox } from "./mapbox";
import { generate as generateMathpix } from "./mathpix";
import { generate as generateMem0 } from "./mem0";
import { generate as generateMercury } from "./mercury";
import { generate as generateMetabase } from "./metabase";
import { generate as generateMetaAds } from "./meta-ads";
import { generate as generateMinimax } from "./minimax";
import { generate as generateMiro } from "./miro";
import { generate as generateMixpanel } from "./mixpanel";
import { generate as generateMonday } from "./monday";
import { generate as generateMoss } from "./moss";
import { generate as generateMsg9 } from "./msg9";
import { generate as generateN8n } from "./n8n";
import { generate as generateNeon } from "./neon";
import { generate as generateNotion } from "./notion";
import { generate as generateNovita } from "./novita";
import { generate as generateNyne } from "./nyne";
import { generate as generateOnyx } from "./onyx";
import { generate as generateOpenai } from "./openai";
import { generate as generateOpenrouter } from "./openrouter";
import { generate as generateOpenweather } from "./openweather";
import { generate as generateOutlookCalendar } from "./outlook-calendar";
import { generate as generateOutlookMail } from "./outlook-mail";
import { generate as generatePandadoc } from "./pandadoc";
import { generate as generateParallel } from "./parallel";
import { generate as generatePdf4me } from "./pdf4me";
import { generate as generatePdfco } from "./pdfco";
import { generate as generatePdforge } from "./pdforge";
import { generate as generatePeopleDataLabs } from "./people-data-labs";
import { generate as generatePerplexity } from "./perplexity";
import { generate as generatePika } from "./pika";
import { generate as generatePinecone } from "./pinecone";
import { generate as generatePipedrive } from "./pipedrive";
import { generate as generatePlain } from "./plain";
import { generate as generatePlausible } from "./plausible";
import { generate as generatePodchaser } from "./podchaser";
import { generate as generatePosthog } from "./posthog";
import { generate as generateProductlane } from "./productlane";
import { generate as generatePrismaPostgres } from "./prisma-postgres";
import { generate as generatePushinator } from "./pushinator";
import { generate as generateQdrant } from "./qdrant";
import { generate as generateQiita } from "./qiita";
import { generate as generateRailway } from "./railway";
import { generate as generateRailwayProject } from "./railway-project";
import { generate as generateReddit } from "./reddit";
import { generate as generateReap } from "./reap";
import { generate as generateReducto } from "./reducto";
import { generate as generateReportei } from "./reportei";
import { generate as generateReplicate } from "./replicate";
import { generate as generateResend } from "./resend";
import { generate as generateRevenuecat } from "./revenuecat";
import { generate as generateRunway } from "./runway";
import { generate as generateScrapeninja } from "./scrapeninja";
import { generate as generateSalesforce } from "./salesforce";
import { generate as generateSegment } from "./segment";
import { generate as generateSentry } from "./sentry";
import { generate as generateSerpapi } from "./serpapi";
import { generate as generateShopify } from "./shopify";
import { generate as generateShortio } from "./shortio";
import { generate as generateStabilityAi } from "./stability-ai";
import { generate as generateSimilarweb } from "./similarweb";
import { generate as generateSlack } from "./slack";
import { generate as generateSlackWebhook } from "./slack-webhook";
import { generate as generateSponge } from "./sponge";
import { generate as generateSproutGigs } from "./sproutgigs";
import { generate as generateSpotify } from "./spotify";
import { generate as generateStrava } from "./strava";
import { generate as generateStreak } from "./streak";
import { generate as generateStrapi } from "./strapi";
import { generate as generateStripe } from "./stripe";
import { generate as generateSupabase } from "./supabase";
import { generate as generateSupadata } from "./supadata";
import { generate as generateSupermemory } from "./supermemory";
import { generate as generateTavily } from "./tavily";
import { generate as generateTestOauth } from "./test-oauth";
import { generate as generateTldv } from "./tldv";
import { generate as generateTodoist } from "./todoist";
import { generate as generateTogether } from "./together";
import { generate as generateTwenty } from "./twenty";
import { generate as generateTypeform } from "./typeform";
import { generate as generateV0 } from "./v0";
import { generate as generateVercel } from "./vercel";
import { generate as generateWebflow } from "./webflow";
import { generate as generateWeread } from "./weread";
import { generate as generateWix } from "./wix";
import { generate as generateWorkos } from "./workos";
import { generate as generateWrike } from "./wrike";
import { generate as generateX } from "./x";
import { generate as generateXero } from "./xero";
import { generate as generateZapier } from "./zapier";
import { generate as generateZapsign } from "./zapsign";
import { generate as generateZendesk } from "./zendesk";
import { generate as generateZep } from "./zep";
import { generate as generateZeptomail } from "./zeptomail";
import { generate as generateWandb } from "./wandb";
import { generate as generateZoom } from "./zoom";
import { generate as generateGoogleAds } from "./google-ads";
import { generate as generateGoogleMaps } from "./google-maps";
import { generate as generateAltium365 } from "./altium-365";
import { generate as generateBrowserstack } from "./browserstack";
import { generate as generateSendgrid } from "./sendgrid";
import { generate as generateServicenow } from "./servicenow";
import { generate as generateTestrail } from "./testrail";
import { generate as generateTwilio } from "./twilio";
import { generate as generateSquare } from "./square";
import { generate as generateGong } from "./gong";
import { generate as generateIronclad } from "./ironclad";
import { generate as generateSnowflake } from "./snowflake";
import { createGoogleGenerator, googleServiceNames } from "./google";

const GENERATORS: Record<string, () => Promise<void>> = {
  agentmail: generateAgentmail,
  amplitude: generateAmplitude,
  "anthropic-managed-agents": generateAnthropicManagedAgents,
  ahrefs: generateAhrefs,
  agora: generateAgora,
  airtable: generateAirtable,
  apollo: generateApollo,
  apify: generateApify,
  asana: generateAsana,
  attio: generateAttio,
  atlassian: generateAtlassian,
  atlascloud: generateAtlascloud,
  axiom: generateAxiom,
  base44: generateBase44,
  bentoml: generateBentoml,
  bitrix: generateBitrix,
  "brave-search": generateBraveSearch,
  brex: generateBrex,
  brevo: generateBrevo,
  "bright-data": generateBrightData,
  browserbase: generateBrowserbase,
  "browser-use": generateBrowserUse,
  browserless: generateBrowserless,
  buffer: generateBuffer,
  "cal-com": generateCalCom,
  calendly: generateCalendly,
  canva: generateCanva,
  chatwoot: generateChatwoot,
  checkr: generateCheckr,
  clerk: generateClerk,
  clickup: generateClickup,
  close: generateClose,
  cloudflare: generateCloudflare,
  coda: generateCoda,
  coresignal: generateCoresignal,
  cronlytic: generateCronlytic,
  "customer-io": generateCustomerIo,
  deel: generateDeel,
  deepseek: generateDeepseek,
  doubao: generateDoubao,
  devto: generateDevto,
  dify: generateDify,
  doppler: generateDoppler,
  discord: generateDiscord,
  "discord-webhook": generateDiscordWebhook,
  docusign: generateDocusign,
  db9: generateDb9,
  drive9: generateDrive9,
  dropbox: generateDropbox,
  "dropbox-sign": generateDropboxSign,
  duffel: generateDuffel,
  e2b: generateE2b,
  elevenlabs: generateElevenlabs,
  etsy: generateEtsy,
  exa: generateExa,
  explorium: generateExplorium,
  faire: generateFaire,
  fal: generateFal,
  figma: generateFigma,
  firecrawl: generateFirecrawl,
  fireflies: generateFireflies,
  freshdesk: generateFreshdesk,
  gamma: generateGamma,
  "garmin-connect": generateGarminConnect,
  gemini: generateGemini,
  github: generateGitHub,
  gitlab: generateGitlab,
  "google-ads": generateGoogleAds,
  granola: generateGranola,
  greenhouse: generateGreenhouse,
  groq: generateGroq,
  gumroad: generateGumroad,
  heygen: generateHeygen,
  helicone: generateHelicone,
  htmlcsstoimage: generateHtmlcsstoimage,
  hubspot: generateHubspot,
  "hugging-face": generateHuggingFace,
  hume: generateHume,
  imgur: generateImgur,
  infisical: generateInfisical,
  instagram: generateInstagram,
  instantly: generateInstantly,
  intercom: generateIntercom,
  "intervals-icu": generateIntervalsIcu,
  jam: generateJam,
  jira: generateJira,
  jotform: generateJotform,
  klaviyo: generateKlaviyo,
  kommo: generateKommo,
  lark: generateLark,
  langfuse: generateLangfuse,
  langsmith: generateLangsmith,
  line: generateLine,
  linear: generateLinear,
  loops: generateLoops,
  luma: generateLuma,
  "luma-ai": generateLumaAi,
  mailchimp: generateMailchimp,
  make: generateMake,
  mailsac: generateMailsac,
  manus: generateManus,
  mem0: generateMem0,
  mercury: generateMercury,
  metabase: generateMetabase,
  "meta-ads": generateMetaAds,
  minimax: generateMinimax,
  miro: generateMiro,
  mixpanel: generateMixpanel,
  monday: generateMonday,
  moss: generateMoss,
  msg9: generateMsg9,
  n8n: generateN8n,
  neon: generateNeon,
  notion: generateNotion,
  novita: generateNovita,
  onyx: generateOnyx,
  openai: generateOpenai,
  "outlook-calendar": generateOutlookCalendar,
  "outlook-mail": generateOutlookMail,
  pandadoc: generatePandadoc,
  parallel: generateParallel,
  pdf4me: generatePdf4me,
  pdfco: generatePdfco,
  pdforge: generatePdforge,
  "people-data-labs": generatePeopleDataLabs,
  perplexity: generatePerplexity,
  pika: generatePika,
  pinecone: generatePinecone,
  pipedrive: generatePipedrive,
  plain: generatePlain,
  plausible: generatePlausible,
  podchaser: generatePodchaser,
  posthog: generatePosthog,
  "prisma-postgres": generatePrismaPostgres,
  productlane: generateProductlane,
  pushinator: generatePushinator,
  qdrant: generateQdrant,
  qiita: generateQiita,
  railway: generateRailway,
  "railway-project": generateRailwayProject,
  reddit: generateReddit,
  reap: generateReap,
  reportei: generateReportei,
  replicate: generateReplicate,
  resend: generateResend,
  revenuecat: generateRevenuecat,
  runway: generateRunway,
  salesforce: generateSalesforce,
  scrapeninja: generateScrapeninja,
  segment: generateSegment,
  sentry: generateSentry,
  serpapi: generateSerpapi,
  shopify: generateShopify,
  shortio: generateShortio,
  "stability-ai": generateStabilityAi,
  similarweb: generateSimilarweb,
  slack: generateSlack,
  "slack-webhook": generateSlackWebhook,
  sponge: generateSponge,
  sproutgigs: generateSproutGigs,
  spotify: generateSpotify,
  strava: generateStrava,
  strapi: generateStrapi,
  streak: generateStreak,
  stripe: generateStripe,
  supabase: generateSupabase,
  supadata: generateSupadata,
  supermemory: generateSupermemory,
  tavily: generateTavily,
  "test-oauth": generateTestOauth,
  tldv: generateTldv,
  todoist: generateTodoist,
  together: generateTogether,
  twenty: generateTwenty,
  typeform: generateTypeform,
  v0: generateV0,
  vercel: generateVercel,
  webflow: generateWebflow,
  weread: generateWeread,
  wix: generateWix,
  workos: generateWorkos,
  wrike: generateWrike,
  x: generateX,
  xero: generateXero,
  zapier: generateZapier,
  zapsign: generateZapsign,
  zendesk: generateZendesk,
  zep: generateZep,
  zeptomail: generateZeptomail,
  wandb: generateWandb,
  zoom: generateZoom,
  "altium-365": generateAltium365,
  browserstack: generateBrowserstack,
  sendgrid: generateSendgrid,
  servicenow: generateServicenow,
  testrail: generateTestrail,
  twilio: generateTwilio,
  square: generateSquare,
  gong: generateGong,
  ironclad: generateIronclad,
  snowflake: generateSnowflake,
  aviationstack: generateAviationstack,
  builtwith: generateBuiltwith,
  clado: generateClado,
  diffbot: generateDiffbot,
  "google-maps": generateGoogleMaps,
  hunter: generateHunter,
  mapbox: generateMapbox,
  mathpix: generateMathpix,
  nyne: generateNyne,
  openrouter: generateOpenrouter,
  openweather: generateOpenweather,
  reducto: generateReducto,
  ...Object.fromEntries(
    googleServiceNames.map((name) => [name, createGoogleGenerator(name)]),
  ),
};

async function main(): Promise<void> {
  const target = process.argv[2];

  if (target) {
    const gen = GENERATORS[target];
    if (!gen) {
      console.error(
        `Unknown generator: ${target}. Available: ${Object.keys(GENERATORS).join(", ")}`,
      );
      process.exit(1);
    }
    await gen();
  } else {
    // Run all generators
    for (const [name, gen] of Object.entries(GENERATORS)) {
      console.error(`\n=== ${name} ===`);
      await gen();
    }
  }

  console.error("\nDone.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
