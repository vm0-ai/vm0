/**
 * Firewall config generator entry point.
 *
 * Usage:
 *   tsx src/index.ts           # generate all
 *   tsx src/index.ts github    # generate github only
 */

import { generate as generateAgentmail } from "./agentmail";
import { generate as generateAhrefs } from "./ahrefs";
import { generate as generateAirtable } from "./airtable";
import { generate as generateApify } from "./apify";
import { generate as generateAsana } from "./asana";
import { generate as generateAxiom } from "./axiom";
import { generate as generateBraveSearch } from "./brave-search";
import { generate as generateBrevo } from "./brevo";
import { generate as generateBrightData } from "./bright-data";
import { generate as generateBrowserbase } from "./browserbase";
import { generate as generateBrowserless } from "./browserless";
import { generate as generateCalCom } from "./cal-com";
import { generate as generateCalendly } from "./calendly";
import { generate as generateCanva } from "./canva";
import { generate as generateClickup } from "./clickup";
import { generate as generateClose } from "./close";
import { generate as generateCloudflare } from "./cloudflare";
import { generate as generateConfluence } from "./confluence";
import { generate as generateCronlytic } from "./cronlytic";
import { generate as generateCustomerIo } from "./customer-io";
import { generate as generateDeepseek } from "./deepseek";
import { generate as generateDeel } from "./deel";
import { generate as generateDevto } from "./devto";
import { generate as generateDiscord } from "./discord";
import { generate as generateDropbox } from "./dropbox";
import { generate as generateElevenlabs } from "./elevenlabs";
import { generate as generateExplorium } from "./explorium";
import { generate as generateFal } from "./fal";
import { generate as generateFigma } from "./figma";
import { generate as generateFirecrawl } from "./firecrawl";
import { generate as generateFireflies } from "./fireflies";
import { generate as generateGarminConnect } from "./garmin-connect";
import { generate as generateGitHub } from "./github";
import { generate as generateGitlab } from "./gitlab";
import { generate as generateGranola } from "./granola";
import { generate as generateHeygen } from "./heygen";
import { generate as generateHubspot } from "./hubspot";
import { generate as generateHuggingFace } from "./hugging-face";
import { generate as generateHume } from "./hume";
import { generate as generateImgur } from "./imgur";
import { generate as generateInstantly } from "./instantly";
import { generate as generateIntercom } from "./intercom";
import { generate as generateIntervalsIcu } from "./intervals-icu";
import { generate as generateJira } from "./jira";
import { generate as generateJotform } from "./jotform";
import { generate as generateLark } from "./lark";
import { generate as generateLine } from "./line";
import { generate as generateLinear } from "./linear";
import { generate as generateLoops } from "./loops";
import { generate as generateMailsac } from "./mailsac";
import { generate as generateMercury } from "./mercury";
import { generate as generateMinimax } from "./minimax";
import { generate as generateMonday } from "./monday";
import { generate as generateNeon } from "./neon";
import { generate as generateNotion } from "./notion";
import { generate as generateOpenai } from "./openai";
import { generate as generatePdf4me } from "./pdf4me";
import { generate as generatePdfco } from "./pdfco";
import { generate as generatePdforge } from "./pdforge";
import { generate as generatePerplexity } from "./perplexity";
import { generate as generatePlausible } from "./plausible";
import { generate as generatePodchaser } from "./podchaser";
import { generate as generatePosthog } from "./posthog";
import { generate as generateProductlane } from "./productlane";
import { generate as generatePushinator } from "./pushinator";
import { generate as generateQiita } from "./qiita";
import { generate as generateReddit } from "./reddit";
import { generate as generateReportei } from "./reportei";
import { generate as generateResend } from "./resend";
import { generate as generateRevenuecat } from "./revenuecat";
import { generate as generateRunway } from "./runway";
import { generate as generateScrapeninja } from "./scrapeninja";
import { generate as generateSentry } from "./sentry";
import { generate as generateSerpapi } from "./serpapi";
import { generate as generateShortio } from "./shortio";
import { generate as generateSimilarweb } from "./similarweb";
import { generate as generateSlack } from "./slack";
import { generate as generateStrava } from "./strava";
import { generate as generateStripe } from "./stripe";
import { generate as generateSupabase } from "./supabase";
import { generate as generateSupadata } from "./supadata";
import { generate as generateTavily } from "./tavily";
import { generate as generateTldv } from "./tldv";
import { generate as generateTodoist } from "./todoist";
import { generate as generateV0 } from "./v0";
import { generate as generateVercel } from "./vercel";
import { generate as generateWebflow } from "./webflow";
import { generate as generateWix } from "./wix";
import { generate as generateX } from "./x";
import { generate as generateXero } from "./xero";
import { generate as generateYoutube } from "./youtube";
import { generate as generateZapier } from "./zapier";
import { generate as generateZapsign } from "./zapsign";
import { generate as generateZeptomail } from "./zeptomail";
import { createGoogleGenerator, googleServiceNames } from "./google";

const GENERATORS: Record<string, () => Promise<void>> = {
  agentmail: generateAgentmail,
  ahrefs: generateAhrefs,
  airtable: generateAirtable,
  apify: generateApify,
  asana: generateAsana,
  axiom: generateAxiom,
  "brave-search": generateBraveSearch,
  brevo: generateBrevo,
  "bright-data": generateBrightData,
  browserbase: generateBrowserbase,
  browserless: generateBrowserless,
  "cal-com": generateCalCom,
  calendly: generateCalendly,
  canva: generateCanva,
  clickup: generateClickup,
  close: generateClose,
  cloudflare: generateCloudflare,
  confluence: generateConfluence,
  cronlytic: generateCronlytic,
  "customer-io": generateCustomerIo,
  deepseek: generateDeepseek,
  deel: generateDeel,
  devto: generateDevto,
  discord: generateDiscord,
  dropbox: generateDropbox,
  elevenlabs: generateElevenlabs,
  explorium: generateExplorium,
  fal: generateFal,
  figma: generateFigma,
  firecrawl: generateFirecrawl,
  fireflies: generateFireflies,
  "garmin-connect": generateGarminConnect,
  github: generateGitHub,
  gitlab: generateGitlab,
  granola: generateGranola,
  heygen: generateHeygen,
  hubspot: generateHubspot,
  "hugging-face": generateHuggingFace,
  hume: generateHume,
  imgur: generateImgur,
  instantly: generateInstantly,
  intercom: generateIntercom,
  "intervals-icu": generateIntervalsIcu,
  jira: generateJira,
  jotform: generateJotform,
  lark: generateLark,
  line: generateLine,
  linear: generateLinear,
  loops: generateLoops,
  mailsac: generateMailsac,
  mercury: generateMercury,
  minimax: generateMinimax,
  monday: generateMonday,
  neon: generateNeon,
  notion: generateNotion,
  openai: generateOpenai,
  pdf4me: generatePdf4me,
  pdfco: generatePdfco,
  pdforge: generatePdforge,
  perplexity: generatePerplexity,
  plausible: generatePlausible,
  podchaser: generatePodchaser,
  posthog: generatePosthog,
  productlane: generateProductlane,
  pushinator: generatePushinator,
  qiita: generateQiita,
  reddit: generateReddit,
  reportei: generateReportei,
  resend: generateResend,
  revenuecat: generateRevenuecat,
  runway: generateRunway,
  scrapeninja: generateScrapeninja,
  sentry: generateSentry,
  serpapi: generateSerpapi,
  shortio: generateShortio,
  similarweb: generateSimilarweb,
  slack: generateSlack,
  strava: generateStrava,
  stripe: generateStripe,
  supabase: generateSupabase,
  supadata: generateSupadata,
  tavily: generateTavily,
  tldv: generateTldv,
  todoist: generateTodoist,
  v0: generateV0,
  vercel: generateVercel,
  webflow: generateWebflow,
  wix: generateWix,
  x: generateX,
  xero: generateXero,
  youtube: generateYoutube,
  zapier: generateZapier,
  zapsign: generateZapsign,
  zeptomail: generateZeptomail,
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
