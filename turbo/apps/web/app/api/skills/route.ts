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
  lark: {
    category: "Communication",
    logo: "/skills/lark.png",
    description:
      "Integrate with Lark (Feishu) for team collaboration, messaging, and workflow automation",
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
  github: {
    category: "Development",
    logo: "/skills/github.svg",
    description:
      "Manage repositories, issues, pull requests, and automate your GitHub workflows",
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
    logo: "https://cdn.simpleicons.org/supabase",
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

async function fetchSkillMetadata(
  skillName: string,
): Promise<SkillMetadata | null> {
  try {
    const categoryInfo = SKILL_CATEGORIES[skillName] || { category: "Other" };

    // Use curated description if available, otherwise fetch from SKILL.md
    if (categoryInfo.description) {
      return {
        name: skillName,
        description: categoryInfo.description,
        category: categoryInfo.category,
        logo: categoryInfo.logo,
        docsUrl: `https://github.com/vm0-ai/vm0-skills/tree/main/${skillName}`,
      };
    }

    // Fallback: fetch from SKILL.md if no curated description
    const response = await fetch(
      `https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/${skillName}/SKILL.md`,
      {
        headers: {
          "User-Agent": "VM0-Website",
        },
        next: { revalidate: 3600 },
      },
    );

    if (!response.ok) {
      return {
        name: skillName,
        description: `${skillName} integration for VM0`,
        category: categoryInfo.category,
        logo: categoryInfo.logo,
        docsUrl: `https://github.com/vm0-ai/vm0-skills/tree/main/${skillName}`,
      };
    }

    const content = await response.text();

    // Parse the markdown content to extract description
    const lines = content.split("\n");
    let description = "";

    // Look for the first paragraph after the title
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (
        line &&
        !line.startsWith("#") &&
        !line.startsWith("-") &&
        !line.startsWith("*")
      ) {
        description = line;
        break;
      }
    }

    return {
      name: skillName,
      description: description || `${skillName} integration for VM0`,
      category: categoryInfo.category,
      logo: categoryInfo.logo,
      docsUrl: `https://github.com/vm0-ai/vm0-skills/tree/main/${skillName}`,
    };
  } catch (error) {
    console.error(`Failed to fetch metadata for ${skillName}:`, error);
    return null;
  }
}

export async function GET() {
  try {
    const skillNames = await fetchSkillsList();

    // Fetch metadata for all skills in parallel
    const skillsPromises = skillNames.map((name) => fetchSkillMetadata(name));
    const skillsData = await Promise.all(skillsPromises);

    // Filter out null values and sort by category
    const skills = skillsData
      .filter((skill): skill is SkillMetadata => skill !== null)
      .sort((a, b) => {
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
  } catch (error) {
    console.error("Error fetching skills:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch skills",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
