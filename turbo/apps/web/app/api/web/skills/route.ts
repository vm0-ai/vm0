import { NextResponse } from "next/server";

export const runtime = "edge";
export const revalidate = 3600; // Cache for 1 hour

interface SkillMetadata {
  name: string;
  description: string;
  category: string;
  logo?: string;
  docsUrl?: string;
  setupRequired?: string[];
}

// Mapping of skill names to categories, descriptions, and metadata
const SKILL_CATEGORIES: Record<
  string,
  { category: string; logo?: string; description?: string }
> = {
  // Communication & Messaging
  slack: {
    category: "Communication",
    logo: "/skills/slack.svg",
    description:
      "Send messages, create channels, and manage your Slack workspace programmatically",
  },
  "slack-webhook": {
    category: "Communication",
    logo: "/skills/slack.svg",
    description:
      "Post messages to Slack channels using incoming webhooks for simple, secure notifications",
  },
  chatwoot: {
    category: "Communication",
    logo: "/skills/chatwoot.svg",
    description:
      "Manage customer conversations and support tickets with open-source live chat platform",
  },
  intercom: {
    category: "Communication",
    logo: "https://cdn.simpleicons.org/intercom",
    description:
      "Manage customer conversations, contacts, messages, and support tickets via Intercom REST API",
  },
  zendesk: {
    category: "Communication",
    logo: "https://cdn.simpleicons.org/zendesk",
    description:
      "Manage support tickets, users, organizations, and automate customer support workflows",
  },
  lark: {
    category: "Communication",
    logo: "/skills/lark.png",
    description:
      "Integrate with Lark (Feishu) for team collaboration, messaging, and workflow automation",
  },
  discord: {
    category: "Communication",
    logo: "https://cdn.simpleicons.org/discord",
    description:
      "Manage Discord servers, channels, and messages for community engagement and automation",
  },
  "discord-webhook": {
    category: "Communication",
    logo: "https://cdn.simpleicons.org/discord",
    description:
      "Send messages to Discord channels using webhooks for simple notifications and alerts",
  },
  zeptomail: {
    category: "Communication",
    logo: "https://cdn.simpleicons.org/zoho",
    description:
      "Send transactional emails reliably with Zoho ZeptoMail's developer-focused email service",
  },

  // Search & Information
  "brave-search": {
    category: "Search",
    logo: "/skills/brave.svg",
    description:
      "Privacy-focused web search API powered by Brave's independent search index",
  },
  tavily: {
    category: "Search",
    logo: "/skills/tavily.svg",
    description:
      "AI-optimized search API designed for LLMs and RAG applications with structured results",
  },
  perplexity: {
    category: "Search",
    logo: "/skills/perplexity.svg",
    description:
      "Answer engine that combines search with AI to deliver accurate, cited answers",
  },
  serpapi: {
    category: "Search",
    logo: "/skills/serpapi.png",
    description:
      "Scrape Google, Bing, and other search engines with real-time structured results API",
  },
  "rss-fetch": {
    category: "Search",
    logo: "/skills/rss.svg",
    description:
      "Fetch and parse RSS/Atom feeds to monitor content updates from websites and blogs",
  },

  // Web Scraping & Data
  firecrawl: {
    category: "Web Scraping",
    logo: "/skills/firecrawl.svg",
    description:
      "Turn websites into LLM-ready markdown with powerful crawling and scraping capabilities",
  },
  browserless: {
    category: "Web Scraping",
    logo: "/skills/browserless.png",
    description:
      "Headless browser automation for web scraping, screenshots, and PDF generation",
  },
  scrapeninja: {
    category: "Web Scraping",
    logo: "/skills/scrapeninja.svg",
    description:
      "Proxy-powered web scraping API that handles JavaScript rendering and CAPTCHAs",
  },
  apify: {
    category: "Web Scraping",
    logo: "/skills/apify.svg",
    description:
      "Cloud platform for web scraping and automation with ready-made actors and tools",
  },
  "bright-data": {
    category: "Web Scraping",
    logo: "/skills/bright-data.png",
    description:
      "Enterprise web data platform with premium proxies and scraping infrastructure",
  },

  // Development Tools
  ".claude": {
    category: "Development",
    logo: "https://cdn.simpleicons.org/anthropic",
    description:
      "Claude configuration and settings for AI-powered development workflows",
  },
  ".claude-plugin": {
    category: "Development",
    logo: "https://cdn.simpleicons.org/anthropic",
    description:
      "Plugin configuration for extending Claude's capabilities in your development environment",
  },
  ".github": {
    category: "Development",
    logo: "https://cdn.simpleicons.org/github",
    description:
      "GitHub workflows, actions, and repository configuration for CI/CD automation",
  },
  ".vm0": {
    category: "Development",
    logo: "/icon.svg",
    description:
      "Project configuration and agent settings for customizing your development environment",
  },
  vm0: {
    category: "Development",
    logo: "/icon.svg",
    description:
      "API for running AI agents in secure sandboxes. Execute agents, manage runs, and download outputs",
  },
  Vm0: {
    category: "Development",
    logo: "/icon.svg",
    description:
      "API for running AI agents in secure sandboxes. Execute agents, manage runs, and download outputs",
  },
  github: {
    category: "Development",
    logo: "/skills/github.svg",
    description:
      "Automate GitHub operations using gh CLI - manage repositories, issues, pull requests, releases, and workflows",
  },
  gitlab: {
    category: "Development",
    logo: "https://cdn.simpleicons.org/gitlab",
    description:
      "Manage projects, issues, merge requests, and CI/CD pipelines in GitLab via REST API",
  },
  "github-copilot": {
    category: "Development",
    logo: "/skills/githubcopilot.svg",
    description:
      "AI pair programmer that suggests code and entire functions in real-time",
  },
  deepseek: {
    category: "Development",
    logo: "/skills/deepseek.svg",
    description:
      "Advanced AI coding assistant with code generation and technical problem-solving",
  },
  "devto-publish": {
    category: "Development",
    logo: "/skills/devdotto.svg",
    description:
      "Publish and manage technical articles on Dev.to community platform",
  },

  // Cloud & Storage
  minio: {
    category: "Cloud Storage",
    logo: "/skills/minio.svg",
    description:
      "High-performance object storage compatible with Amazon S3 API for cloud-native apps",
  },
  qdrant: {
    category: "Cloud Storage",
    logo: "/skills/qdrant.svg",
    description:
      "Vector database for similarity search and AI applications with advanced filtering",
  },
  cloudinary: {
    category: "Cloud Storage",
    logo: "/skills/cloudinary.svg",
    description:
      "Media management platform for storing, optimizing, and delivering images and videos",
  },
  supadata: {
    category: "Cloud Storage",
    logo: "https://supadata.ai/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Ficon.8f3889d2.png&w=96&q=75&dpl=dpl_GGskfKoNNpXph8gL1E9RdzV5k9gX",
    description:
      "Data infrastructure platform for building and scaling AI-powered applications",
  },

  // AI & Media Generation
  elevenlabs: {
    category: "AI & Media",
    logo: "/skills/elevenlabs.svg",
    description:
      "Generate natural-sounding speech with advanced AI voice synthesis and cloning",
  },
  "fal-image": {
    category: "AI & Media",
    logo: "/skills/fal-image.svg",
    description:
      "Fast and scalable AI image generation with Stable Diffusion and other models",
  },
  "fal.ai": {
    category: "AI & Media",
    logo: "/skills/fal-image.svg",
    description:
      "Serverless AI infrastructure for running ML models with low latency and high scalability",
  },
  openai: {
    category: "AI & Media",
    logo: "https://upload.wikimedia.org/wikipedia/commons/e/ef/ChatGPT-Logo.svg",
    description:
      "Access GPT models, DALL-E, Whisper, and other OpenAI APIs for advanced AI capabilities",
  },
  runway: {
    category: "AI & Media",
    logo: "/skills/runway.svg",
    description:
      "AI-powered video editing and generation tools for creative professionals",
  },
  htmlcsstoimage: {
    category: "AI & Media",
    logo: "/skills/htmlcsstoimage.png",
    description:
      "Convert HTML/CSS to high-quality images and screenshots via API",
  },

  // Project Management
  notion: {
    category: "Productivity",
    logo: "/skills/notion.svg",
    description:
      "Create, read, and update pages in your Notion workspace for knowledge management",
  },
  figma: {
    category: "Productivity",
    logo: "https://cdn.simpleicons.org/figma",
    description:
      "Access design files, comments, components, and projects in Figma workspaces via REST API",
  },
  jira: {
    category: "Productivity",
    logo: "https://cdn.simpleicons.org/jira",
    description:
      "Create, update, search, and manage issues, projects, and workflows in Jira Cloud",
  },
  "google-sheets": {
    category: "Productivity",
    logo: "https://cdn.simpleicons.org/googlesheets",
    description:
      "Read, write, and manage data in Google Sheets for collaborative spreadsheet automation",
  },
  linear: {
    category: "Productivity",
    logo: "https://cdn.simpleicons.org/linear",
    description:
      "Modern issue tracking and project management for software development teams",
  },
  monday: {
    category: "Productivity",
    logo: "/skills/monday.svg",
    description:
      "Project management and team collaboration platform with customizable workflows",
  },
  instantly: {
    category: "Productivity",
    logo: "https://cdn.simpleicons.org/maildotru",
    description:
      "Email outreach and cold email automation platform for sales and marketing teams",
  },

  // Document Processing
  pdfco: {
    category: "Documents",
    logo: "/skills/pdfco.svg",
    description:
      "PDF processing API for creating, editing, converting, and extracting data from PDFs",
  },
  pdforge: {
    category: "Documents",
    logo: "/skills/pdforge.svg",
    description:
      "Generate professional PDF documents from templates with dynamic data",
  },
  zapsign: {
    category: "Documents",
    logo: "/skills/zapsign.svg",
    description:
      "Electronic signature platform for signing and managing documents digitally",
  },

  // Analytics & Monitoring
  axiom: {
    category: "Analytics",
    logo: "data:image/svg+xml,%3Csvg width='68' height='60' viewBox='0 0 17 15' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M16.5089 10.1066L13.0911 4.31803C12.9344 4.05199 12.5482 3.83432 12.2329 3.83432H10.0991C9.60314 3.83432 9.39981 3.49237 9.64721 3.07442L10.8173 1.0978C10.9102 0.940926 10.91 0.747804 10.8168 0.5911C10.7236 0.434397 10.5516 0.337891 10.3655 0.337891H7.38875C7.07344 0.337891 6.68637 0.555072 6.52858 0.820524L0.744369 10.5524C0.586609 10.8178 0.586487 11.2522 0.744156 11.5177L2.23248 14.0243C2.48046 14.442 2.88713 14.4425 3.13616 14.0254L4.29915 12.0781C4.54819 11.661 4.95486 11.6615 5.20283 12.0792L6.25715 13.8548C6.41479 14.1203 6.80177 14.3376 7.11707 14.3376H13.9955C14.3109 14.3376 14.6978 14.1203 14.8555 13.8548L16.5072 11.0731C16.6649 10.8075 16.6656 10.3726 16.5089 10.1066ZM11.8932 9.828C12.1396 10.2465 11.9355 10.5889 11.4395 10.5889H6.08915C5.5932 10.5889 5.39029 10.2472 5.63826 9.82956L8.31555 5.32067C8.56352 4.90304 8.96929 4.90305 9.21723 5.3207L11.8932 9.828Z' fill='%2309101F'/%3E%3C/svg%3E",
    description:
      "Cloud-native observability platform for storing, querying, and analyzing logs and events at scale",
  },
  browserbase: {
    category: "Web Scraping",
    logo: "https://www.browserbase.com/assets/browserbase_logo_text.svg",
    description:
      "Serverless browser infrastructure for web scraping, testing, and automation at scale",
  },
  mercury: {
    category: "Web Scraping",
    logo: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Cpath d='M23.9473,15.9296872c0-1.1955996.8087997-2.0044003,2.0394993-2.0044003,1.1253014,0,1.898901.8088007,1.898901,2.0044003,0,1.1603994-.7735996,1.934001-1.898901,1.934001-1.2306995,0-2.0394993-.7736015-2.0394993-1.934001ZM20.9230995,9.6703173c.7033005-1.0197697,1.1604004-2.2505503,1.1604004-3.9736099,1.7231007,1.0197797,3.1648006,2.4615002,4.1846008,4.1846094-1.6879005,0-2.9187012.4570704-3.9384003,1.19557-.3868999-.5274992-.8791008-1.0196991-1.406601-1.4065695ZM20.8526993,22.2592875c.5275002-.3866997.9847012-.8791008,1.406601-1.3714008,1.0198002.7737007,2.285799,1.2308006,4.0088005,1.2308006-1.0198002,1.7581997-2.4615002,3.2000008-4.1846008,4.1846008,0-1.7582016-.4570999-3.0242004-1.2308006-4.0440006ZM19.7978001,1.3714173c6.5757999,1.6527499,11.287899,7.4901298,11.287899,14.62857,0,2.9890003-2.2504997,5.2043991-5.169199,5.2043991-1.1956005,0-2.3209-.3867989-3.1648006-1.0197983.4570999-.7384014.7735996-1.5472012.9846001-2.4264011.5626011.6329994,1.3714008,1.0198002,2.2504997,1.0198002,1.5121002,0,2.8132-1.3010998,2.8132-2.8483,0-4.8879004-2.8132-9.17803-6.9273987-11.3231101-.3164997-1.2659297-1.0902004-2.4263699-2.0748005-3.2351598ZM18.1450996,20.1845881c1.5121002-.7736015,2.5669994-2.3560009,2.5669994-4.1846008,0-3.4462004,3.0593014-5.6967001,6.0835018-5.1341.3867989.8439999.6680984,1.7933998.8790989,2.7428999-.4923-.3867998-1.0548992-.5978003-1.6879005-.5978003-1.6175995,0-2.9538994,1.3362999-2.9538994,2.9187002,0,2.3912001-1.0900993,4.4306993-2.7427998,5.6967001-.5977993-.6329994-1.3362999-1.1252995-2.1450005-1.4417992ZM14.0307999,6.1186573c0-1.19559.8087997-2.0043898,2.0394993-2.0043898,1.1253014,0,1.898901.8087997,1.898901,2.0043898,0,1.16044-.7735996,1.9340501-1.898901,1.9340501-1.2306995,0-2.0394993-.7736101-2.0394993-1.9340501ZM14.0307999,25.9516875c0-1.1956005.8087997-2.0044003,2.0394993-2.0044003,1.1253014,0,1.898901.8087997,1.898901,2.0044003,0,1.1604004-.7735996,1.934-1.898901,1.934-1.2306995,0-2.0394993-.7735996-2.0394993-1.934ZM12.2021999,15.9999873c0-2.1801996,1.6176004-3.7978001,3.8330002-3.7978001,2.1802006,0,3.7625999,1.6176004,3.7625999,3.7978001,0,2.2154007-1.5823994,3.7978001-3.7625999,3.7978001-2.2153997,0-3.8330002-1.5823994-3.8330002-3.7978001ZM16.0352001,11.2878872c-3.3759003,0-5.6264-2.81318-5.1341-6.0483398.8790998-.4219799,1.8636999-.7384601,2.8483-.91429-.3867998.49231-.6329002,1.1252899-.6329002,1.7933998,0,1.5472698,1.3361998,2.8483901,2.9537992,2.8483901,2.3561001,0,4.3956013.9846096,5.6264,2.6373396-.6680984.6330004-1.1603985,1.4066-1.5120983,2.2505007-.7736015-1.5121002-2.3560009-2.5670004-4.1494007-2.5670004ZM10.8308001,25.8812872c0-1.1956005.3867998-2.2856998,1.0198002-3.1296005.7031994.4218998,1.4769001.7735996,2.3207998.9846001-.6330004.527401-1.0549002,1.3362999-1.0549002,2.2154007,0,1.5471992,1.3361998,2.848299,2.9537992,2.848299,4.9231014,0,9.1429005-2.7779999,11.2528-6.8571987,1.3011017-.3164005,2.4615002-1.0549011,3.2702999-2.0747013-1.6526985,6.5407009-7.4549999,11.2175999-14.593399,11.2175999-2.9187002,0-5.1691999-2.2504997-5.1691999-5.2043991ZM10.4088001,20.3252875c.5978003-.6329994,1.0901003-1.3715,1.4066-2.1802006.7735996,1.5121002,2.3912001,2.5669994,4.2198,2.5669994,3.3757992,0,5.5911999,2.9890003,5.0636997,6.1187-.8790989.3868008-1.8285999.7033005-2.8132.8791008.3516998-.4923.5977993-1.0900993.5977993-1.7581997,0-1.5825005-1.3010998-2.9188004-2.8132-2.9188004-2.355999,0-4.3955994-1.0548992-5.661499-2.7075996ZM5.7670598,22.1186873c1.68788,0,2.9538302-.4570999,3.9736104-1.2308006.4219294.4923.8791294.9847012,1.4066296,1.3714008-.7736998,1.0198002-1.2307997,2.285799-1.2307997,4.0088005-1.7231102-1.0198002-3.1296701-2.4263-4.1494403-4.1494007ZM5.7318902,9.8813168c1.0197797-1.6879396,2.4614997-3.1296597,4.1846099-4.1494393,0,1.7582197.4570999,3.0241694,1.2658997,4.0439401-.5275002.3867693-1.0198002.8439693-1.4065695,1.3714695-1.0197706-.8088999-2.2857203-1.2659702-4.0439401-1.2659702ZM4.2901101,18.1450869c.5274701.3868008,1.16044.6329002,1.8637199.6329002,1.5121098,0,2.81323-1.3010998,2.81323-2.8483,0-2.2858,1.0901403-4.2550001,2.7428398-5.5208998.6329002.5978003,1.3713999,1.0901003,2.1801996,1.4066-1.5472994.7735996-2.6021996,2.3912001-2.6021996,4.1845999,0,3.4461994-2.9186802,5.6264-6.0483398,5.1341-.4219799-.9494991-.7384601-1.9340992-.94945-2.9890003ZM4.1142802,15.9296872c0-1.1955996.8087997-2.0044003,2.0395498-2.0044003,1.1252799,0,1.89889.8088007,1.89889,2.0044003,0,1.1603994-.7736101,1.934001-1.89889,1.934001-1.2307501,0-2.0395498-.7736015-2.0395498-1.934001ZM1.37143,12.1670872C3.05934,5.5912072,8.8615599.9142702,15.9647999.9142702c2.9538994,0,5.204401,2.250547,5.204401,5.1692169,0,1.19561-.3516006,2.2505598-.9493999,3.0945005-.7033005-.4219408-1.4770012-.7384405-2.3209019-.9142809.5978012-.5274396.9846001-1.3011098.9846001-2.1450496,0-1.5823998-1.3010998-2.9186699-2.8132-2.9186699-4.9581995,0-9.2482991,2.8131697-11.3933792,6.8572004-1.3011.3163996-2.46154,1.0900993-3.3054899,2.1098995ZM.914283,15.9999873c0-2.9538002,2.250547-5.2044001,5.204387-5.2044001,1.19561,0,2.2857203.3867998,3.1296601,1.0550003-.4219398.6680994-.7384405,1.4066-.94944,2.2152996-.5274501-.6329994-1.3011103-1.0549002-2.1450601-1.0549002-1.6175599,0-2.95383,1.3362999-2.95383,2.9187002,0,4.9933996,2.7780001,9.2482996,6.8923004,11.4285002.3164997,1.3010998,1.0900993,2.4263992,2.1098995,3.2703991C5.62639,29.0109869.914283,23.1735865.914283,15.9999873ZM15.9647999,31.9999873c8.5450993,0,16.0352001-6.8220005,16.0352001-16C32,7.1384274,24.8616009-.0000127,15.9647999-.0000127,7.1384401-.0000127,0,7.1384274,0,15.9999873c0,8.8616009,7.1384401,16,15.9647999,16Z'/%3E%3C/svg%3E",
    description:
      "API for parsing and extracting structured data from web pages with automatic schema detection",
  },
  podchaser: {
    category: "Content",
    logo: "https://cdn.simpleicons.org/applepodcasts",
    description:
      "Podcast database and discovery platform for searching and accessing podcast metadata",
  },
  sentry: {
    category: "Analytics",
    logo: "https://cdn.simpleicons.org/sentry",
    description:
      "Error tracking and monitoring platform to manage issues, resolve errors, and monitor releases",
  },
  plausible: {
    category: "Analytics",
    logo: "/skills/plausible.svg",
    description:
      "Privacy-friendly website analytics without cookies or personal data collection",
  },
  cronlytic: {
    category: "Analytics",
    logo: "/skills/cronlytic.png",
    description:
      "Cron job monitoring and alerting service to track scheduled task execution",
  },

  // Content Publishing
  qiita: {
    category: "Content",
    logo: "/skills/qiita.svg",
    description:
      "Share technical knowledge on Japan's largest programming community platform",
  },
  youtube: {
    category: "Content",
    logo: "https://cdn.simpleicons.org/youtube",
    description:
      "Search videos, get video/channel information, list playlists, and fetch comments via YouTube Data API",
  },
  instagram: {
    category: "Content",
    logo: "/skills/instagram.svg",
    description:
      "Automate Instagram posts, stories, and engage with your audience programmatically",
  },
  imgur: {
    category: "Content",
    logo: "/skills/imgur.svg",
    description:
      "Upload and share images on Imgur's popular image hosting and sharing platform",
  },

  // Utilities
  shortio: {
    category: "Utilities",
    logo: "https://cdn.simpleicons.org/bitly",
    description:
      "URL shortening and link management with custom domains and analytics tracking",
  },
  minimax: {
    category: "Utilities",
    logo: "/skills/minimax.svg",
    description:
      "Chinese AI platform offering multimodal models for text, speech, and image generation",
  },

  // Additional Services
  bitrix: {
    category: "Productivity",
    logo: "/skills/bitrix.svg",
    description:
      "Business collaboration and CRM platform for team management and workflow automation",
  },
  hackernews: {
    category: "Content",
    logo: "https://cdn.simpleicons.org/ycombinator",
    description:
      "Access and interact with Hacker News API for tech news and discussions",
  },
  kommo: {
    category: "Productivity",
    logo: "/skills/kommo.webp",
    description:
      "Messenger-based CRM for managing customer communications and sales",
  },
  pdf4me: {
    category: "Documents",
    logo: "/skills/pdf4me.svg",
    description:
      "Professional PDF processing and automation platform for document workflows",
  },
  pushinator: {
    category: "Communication",
    logo: "https://cdn.simpleicons.org/pushbullet",
    description:
      "Push notification service for sending alerts and messages across devices",
  },
  reportei: {
    category: "Analytics",
    logo: "https://cdn.simpleicons.org/googleanalytics",
    description:
      "Marketing analytics and reporting platform for agencies and businesses",
  },
  streak: {
    category: "Productivity",
    logo: "https://cdn.simpleicons.org/gmail",
    description:
      "CRM platform integrated with Gmail for managing workflows and pipelines",
  },
  twenty: {
    category: "Productivity",
    logo: "https://cdn.simpleicons.org/airtable",
    description:
      "Modern CRM platform for managing customer relationships and sales processes",
  },
};

interface GitHubContent {
  name: string;
  type: string;
}

async function fetchSkillsList(): Promise<string[]> {
  const response = await fetch(
    "https://api.github.com/repos/vm0-ai/vm0-skills/contents",
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "VM0-Website",
      },
      next: { revalidate: 3600 },
    },
  );

  if (!response.ok) {
    throw new Error("Failed to fetch skills list");
  }

  const contents = (await response.json()) as GitHubContent[];
  return contents
    .filter((item) => item.type === "dir" && item.name !== "docs")
    .map((item) => item.name);
}

// Auto-detect category based on skill name and description keywords
function detectCategory(skillName: string, description: string): string {
  const text = `${skillName} ${description}`.toLowerCase();

  const categoryKeywords: Record<string, string[]> = {
    Communication: [
      "slack",
      "discord",
      "chat",
      "message",
      "email",
      "notification",
      "webhook",
      "lark",
      "feishu",
    ],
    Search: ["search", "scrape", "crawl", "rss", "feed", "index"],
    "Web Scraping": [
      "scrape",
      "crawl",
      "browser",
      "proxy",
      "spider",
      "extract",
    ],
    Development: [
      "github",
      "git",
      "code",
      "repository",
      "copilot",
      "dev",
      "ci/cd",
    ],
    "Cloud Storage": [
      "storage",
      "s3",
      "bucket",
      "database",
      "vector",
      "minio",
      "cloudinary",
    ],
    "AI & Media": [
      "ai",
      "gpt",
      "llm",
      "image",
      "video",
      "audio",
      "speech",
      "generation",
      "openai",
      "model",
    ],
    Productivity: [
      "notion",
      "project",
      "task",
      "crm",
      "sheet",
      "spreadsheet",
      "workflow",
      "linear",
      "issue",
    ],
    Documents: ["pdf", "document", "sign", "signature", "convert"],
    Analytics: ["analytics", "monitoring", "tracking", "metrics", "stats"],
    Content: ["publish", "blog", "post", "instagram", "social", "content"],
  };

  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      return category;
    }
  }

  return "Other";
}

// Generate logo URL based on skill name
function generateLogoUrl(skillName: string): string {
  // Try simpleicons first (convert skill-name to skillname)
  const iconName = skillName.replace(/-/g, "").replace(/_/g, "");
  return `https://cdn.simpleicons.org/${iconName}`;
}

// Transform skill name for display (remove leading dots and handle special cases)
function getDisplayName(skillName: string): string {
  // Special mappings for dotfiles to avoid conflicts
  const specialNames: Record<string, string> = {
    ".github": "GitHub Actions",
    ".claude": "Claude Config",
    ".claude-plugin": "Claude Plugin",
    ".vm0": "VM0 Config",
    vm0: "VM0",
    Vm0: "VM0", // Fix incorrect capitalization
  };

  if (specialNames[skillName]) {
    return specialNames[skillName]!;
  }

  return skillName.startsWith(".") ? skillName.substring(1) : skillName;
}

// Skills with available documentation
const SKILLS_WITH_DOCS = new Set([
  "apify",
  "axiom",
  "bitrix",
  "brave-search",
  "bright-data",
  "browserbase",
  "browserless",
  "chatwoot",
  "cloudinary",
  "cronlytic",
  "deepseek",
  "devto",
  "discord-webhook",
  "discord",
  "elevenlabs",
  "fal-ai",
  "figma",
  "firecrawl",
  "github-copilot",
  "github",
  "gitlab",
  "gmail",
  "google-cloud-console",
  "google-sheets",
  "hackernews",
  "htmlcsstoimage",
  "imgur",
  "instagram",
  "instantly",
  "intercom",
  "jira",
  "kommo",
  "lark",
  "linear",
  "mercury",
  "minimax",
  "minio",
  "monday",
  "notion",
  "openai",
  "pdf4me",
  "pdfco",
  "pdforge",
  "perplexity",
  "plausible",
  "podchaser",
  "pushinator",
  "qdrant",
  "qiita",
  "reportei",
  "resend",
  "rss-fetch",
  "runway",
  "scrapeninja",
  "sentry",
  "serpapi",
  "shortio",
  "slack-webhook",
  "slack",
  "streak",
  "supabase",
  "supadata",
  "tavily",
  "twenty",
  "youtube",
  "zapsign",
  "zendesk",
  "zeptomail",
]);

// Get documentation URL for a skill
function getDocsUrl(skillName: string): string {
  const cleanName = skillName.replace(/^\./, ""); // Remove leading dot
  if (SKILLS_WITH_DOCS.has(cleanName)) {
    return `https://docs.vm0.ai/docs/integration/${cleanName}`;
  }
  return `https://github.com/vm0-ai/vm0-skills/tree/main/${skillName}`;
}

// Parse SKILL.md content intelligently
function parseSkillMarkdown(content: string): {
  description: string;
  setupRequired?: string[];
} {
  const lines = content.split("\n");
  let description = "";
  const setupRequired: string[] = [];

  // Extract description - look for first substantial paragraph
  let inDescription = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();

    // Skip title
    if (line?.startsWith("#")) {
      inDescription = false;
      continue;
    }

    // Skip empty lines
    if (!line) {
      if (description) break; // Stop after first paragraph
      continue;
    }

    // Skip bullets and metadata
    if (line.startsWith("-") || line.startsWith("*") || line.startsWith(">")) {
      continue;
    }

    // Skip bold metadata lines
    if (line.startsWith("**") && line.includes(":**")) {
      continue;
    }

    // Found description text
    if (line.length > 20 && !description) {
      description = line;
      inDescription = true;
      continue;
    }

    // Continue multi-line description
    if (inDescription && line.length > 20) {
      description += " " + line;
    }
  }

  // Extract environment variables
  const envVarMatch = content.match(/`([A-Z_]+_(API_)?KEY|[A-Z_]+_TOKEN)`/g);
  if (envVarMatch) {
    setupRequired.push(
      ...envVarMatch.map((match) => match.replace(/`/g, "").trim()),
    );
  }

  // Clean up description
  description = description
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^(description|summary|overview):\s*/i, "") // Remove metadata prefixes
    .trim();

  // Limit to reasonable length
  if (description.length > 150) {
    description = description.substring(0, 147) + "...";
  }

  return { description, setupRequired: setupRequired.slice(0, 3) };
}

async function fetchSkillMetadata(skillName: string): Promise<SkillMetadata> {
  // 1. Check for curated metadata first (highest priority)
  const curatedInfo = SKILL_CATEGORIES[skillName];
  if (curatedInfo?.description) {
    return {
      name: getDisplayName(skillName),
      description: curatedInfo.description,
      category: curatedInfo.category,
      logo: curatedInfo.logo,
      docsUrl: getDocsUrl(skillName),
    };
  }

  // 2. Try to fetch and parse SKILL.md
  const skillMdResponse = await fetch(
    `https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/${skillName}/SKILL.md`,
    {
      headers: { "User-Agent": "VM0-Website" },
      next: { revalidate: 3600 },
    },
  );

  if (!skillMdResponse.ok) {
    // 3. Ultimate fallback
    return {
      name: getDisplayName(skillName),
      description: `${skillName.replace(/-/g, " ")} integration for VM0 agents`,
      category: curatedInfo?.category || "Other",
      logo: curatedInfo?.logo || generateLogoUrl(skillName),
      docsUrl: getDocsUrl(skillName),
    };
  }

  const content = await skillMdResponse.text();
  const parsed = parseSkillMarkdown(content);

  // Use parsed data with smart fallbacks
  const description =
    parsed.description ||
    `${skillName.replace(/-/g, " ")} integration for VM0 agents`;
  const category =
    curatedInfo?.category || detectCategory(skillName, description);
  const logo = curatedInfo?.logo || generateLogoUrl(skillName);

  return {
    name: getDisplayName(skillName),
    description,
    category,
    logo,
    docsUrl: getDocsUrl(skillName),
    setupRequired: parsed.setupRequired,
  };
}

export async function GET() {
  const skillNames = await fetchSkillsList();

  // Fetch metadata for all skills in parallel
  const skillsPromises = skillNames.map((name) => fetchSkillMetadata(name));
  const skillsData = await Promise.all(skillsPromises);

  // Sort by category
  const skills = skillsData.sort((a, b) => {
    if (a.category === b.category) {
      return a.name.localeCompare(b.name);
    }
    return a.category.localeCompare(b.category);
  });

  // Group by category
  const skillsByCategory = skills.reduce(
    (acc, skill) => {
      if (!acc[skill.category]) {
        acc[skill.category] = [];
      }
      acc[skill.category]!.push(skill);
      return acc;
    },
    {} as Record<string, SkillMetadata[]>,
  );

  return NextResponse.json({
    success: true,
    total: skills.length,
    categories: Object.keys(skillsByCategory).length,
    skillsByCategory,
    skills,
  });
}
