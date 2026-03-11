import type { ConnectorType } from "@vm0/core";

import agentmailIcon from "./icons/agentmail.svg";
import ahrefsIcon from "./icons/ahrefs.svg";
import apifyIcon from "./icons/apify.svg";
import brightDataIcon from "./icons/bright-data.svg";
import browserbaseIcon from "./icons/browserbase.svg";
import browserlessIcon from "./icons/browserless.svg";
import airtableIcon from "./icons/airtable.svg";
import axiomIcon from "./icons/axiom.svg";
import asanaIcon from "./icons/asana.svg";
import atlassianIcon from "./icons/atlassian.svg";
import canvaIcon from "./icons/canva.svg";
import chatwootIcon from "./icons/chatwoot.svg";
import clickupIcon from "./icons/clickup.svg";
import cloudflareIcon from "./icons/cloudflare.svg";
import closeIcon from "./icons/close.svg";
import computerIcon from "./icons/computer.svg";
import deelIcon from "./icons/deel.svg";
import deepseekIcon from "./icons/deepseek.svg";
import difyIcon from "./icons/dify.svg";
import devtoIcon from "./icons/devto.svg";
import docusignIcon from "./icons/docusign.svg";
import dropboxIcon from "./icons/dropbox.svg";
import elevenlabsIcon from "./icons/elevenlabs.svg";
import falIcon from "./icons/fal.svg";
import figmaIcon from "./icons/figma.svg";
import firecrawlIcon from "./icons/firecrawl.svg";
import garminConnectIcon from "./icons/garmin-connect.svg";
import githubIcon from "./icons/github.svg";
import heygenIcon from "./icons/heygen.svg";
import huggingFaceIcon from "./icons/hugging-face.svg";
import hubspotIcon from "./icons/hubspot.svg";
import intercomIcon from "./icons/intercom.svg";
import intervalsIcuIcon from "./icons/intervals-icu.svg";
import gmailIcon from "./icons/gmail.svg";
import googleCalendarIcon from "./icons/google-calendar.svg";
import googleDocsIcon from "./icons/google-docs.svg";
import googleDriveIcon from "./icons/google-drive.svg";
import googleSheetsIcon from "./icons/google-sheets.svg";
import lineIcon from "./icons/line.svg";
import linearIcon from "./icons/linear.svg";
import makeIcon from "./icons/make.svg";
import mailchimpIcon from "./icons/mailchimp.svg";
import mercuryIcon from "./icons/mercury.svg";
import metaAdsIcon from "./icons/meta-ads.svg";
import minimaxIcon from "./icons/minimax.svg";
import mondayIcon from "./icons/monday.svg";
import neonIcon from "./icons/neon.svg";
import notionIcon from "./icons/notion.svg";
import openaiIcon from "./icons/openai.svg";
import outlookCalendarIcon from "./icons/outlook-calendar.svg";
import outlookMailIcon from "./icons/outlook-mail.svg";
import pdf4meIcon from "./icons/pdf4me.svg";
import pdfcoIcon from "./icons/pdfco.svg";
import perplexityIcon from "./icons/perplexity.svg";
import plausibleIcon from "./icons/plausible.svg";
import podchaserIcon from "./icons/podchaser.svg";
import posthogIcon from "./icons/posthog.svg";
import productlaneIcon from "./icons/productlane.svg";
import pushinatorIcon from "./icons/pushinator.svg";
import qdrantIcon from "./icons/qdrant.svg";
import qiitaIcon from "./icons/qiita.svg";
import redditIcon from "./icons/reddit.svg";
import reporteiIcon from "./icons/reportei.svg";
import serpapiIcon from "./icons/serpapi.svg";
import runwayIcon from "./icons/runway.svg";
import shortioIcon from "./icons/shortio.svg";
import streakIcon from "./icons/streak.svg";
import supadataIcon from "./icons/supadata.svg";
import tavilyIcon from "./icons/tavily.svg";
import twentyIcon from "./icons/twenty.svg";
import youtubeIcon from "./icons/youtube.svg";
import zapsignIcon from "./icons/zapsign.svg";
import zendeskIcon from "./icons/zendesk.svg";
import resendIcon from "./icons/resend.svg";
import scrapeninja from "./icons/scrapeninja.svg";
import sentryIcon from "./icons/sentry.svg";
import similarwebIcon from "./icons/similarweb.svg";
import slackIcon from "./icons/slack.svg";
import stravaIcon from "./icons/strava.svg";
import stripeIcon from "./icons/stripe.svg";
import supabaseIcon from "./icons/supabase.svg";
import todoistIcon from "./icons/todoist.svg";
import vercelIcon from "./icons/vercel.svg";
import webflowIcon from "./icons/webflow.svg";
import wrikeIcon from "./icons/wrike.svg";
import xIcon from "./icons/x.svg";
import xeroIcon from "./icons/xero.svg";
import zeptomailIcon from "./icons/zeptomail.svg";

const CONNECTOR_ICONS: Readonly<Record<ConnectorType, string>> = Object.freeze({
  agentmail: agentmailIcon,
  ahrefs: ahrefsIcon,
  airtable: airtableIcon,
  apify: apifyIcon,
  axiom: axiomIcon,
  asana: asanaIcon,
  atlassian: atlassianIcon,
  "bright-data": brightDataIcon,
  browserbase: browserbaseIcon,
  browserless: browserlessIcon,
  canva: canvaIcon,
  chatwoot: chatwootIcon,
  clickup: clickupIcon,
  cloudflare: cloudflareIcon,
  close: closeIcon,
  computer: computerIcon,
  deel: deelIcon,
  deepseek: deepseekIcon,
  dify: difyIcon,
  devto: devtoIcon,
  docusign: docusignIcon,
  dropbox: dropboxIcon,
  elevenlabs: elevenlabsIcon,
  fal: falIcon,
  figma: figmaIcon,
  firecrawl: firecrawlIcon,
  "garmin-connect": garminConnectIcon,
  github: githubIcon,
  gmail: gmailIcon,
  heygen: heygenIcon,
  "hugging-face": huggingFaceIcon,
  hubspot: hubspotIcon,
  "google-calendar": googleCalendarIcon,
  "google-docs": googleDocsIcon,
  "google-drive": googleDriveIcon,
  "google-sheets": googleSheetsIcon,
  intercom: intercomIcon,
  "intervals-icu": intervalsIcuIcon,
  line: lineIcon,
  linear: linearIcon,
  make: makeIcon,
  mailchimp: mailchimpIcon,
  mercury: mercuryIcon,
  "meta-ads": metaAdsIcon,
  minimax: minimaxIcon,
  monday: mondayIcon,
  neon: neonIcon,
  notion: notionIcon,
  openai: openaiIcon,
  "outlook-calendar": outlookCalendarIcon,
  "outlook-mail": outlookMailIcon,
  pdf4me: pdf4meIcon,
  pdfco: pdfcoIcon,
  perplexity: perplexityIcon,
  plausible: plausibleIcon,
  podchaser: podchaserIcon,
  posthog: posthogIcon,
  productlane: productlaneIcon,
  pushinator: pushinatorIcon,
  qdrant: qdrantIcon,
  qiita: qiitaIcon,
  reddit: redditIcon,
  reportei: reporteiIcon,
  serpapi: serpapiIcon,
  runway: runwayIcon,
  shortio: shortioIcon,
  streak: streakIcon,
  supadata: supadataIcon,
  tavily: tavilyIcon,
  twenty: twentyIcon,
  youtube: youtubeIcon,
  zapsign: zapsignIcon,
  zendesk: zendeskIcon,
  resend: resendIcon,
  scrapeninja: scrapeninja,
  sentry: sentryIcon,
  similarweb: similarwebIcon,
  slack: slackIcon,
  strava: stravaIcon,
  stripe: stripeIcon,
  supabase: supabaseIcon,
  todoist: todoistIcon,
  vercel: vercelIcon,
  webflow: webflowIcon,
  wrike: wrikeIcon,
  x: xIcon,
  xero: xeroIcon,
  zeptomail: zeptomailIcon,
});

export function ConnectorIcon({
  type,
  size = 28,
}: {
  type: ConnectorType;
  size?: number;
}) {
  const icon = CONNECTOR_ICONS[type];
  return (
    <img src={icon} width={size} height={size} alt="" className="shrink-0" />
  );
}
