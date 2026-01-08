import { NextResponse } from "next/server";

export const runtime = "edge";
export const revalidate = 3600; // Cache for 1 hour

interface CookbookMetadata {
  id: string;
  name: string;
  description: string;
  icon: string;
  docsUrl: string;
}

interface GitHubContent {
  name: string;
  type: string;
}

// Optimize title for readability
function optimizeTitle(rawName: string, cookbookId: string): string {
  // Special case mappings
  const specialCases: Record<string, string> = {
    intro: "Getting Started with VM0",
    "hf-trainer": "Hugging Face Model Trainer",
    "tiktok-influencer": "TikTok Influencer Bot",
    "firecrawl-summary": "Firecrawl Web Scraper",
    "github-agent": "GitHub Automation Agent",
    "daily-data-report": "Daily Data Report Generator",
    "intro-skills": "Introduction to Skills",
    "writing-agent": "AI Writing Assistant",
    "fetch-stores": "Data Fetching & Storage",
    "content-farm": "Content Generation Farm",
    "competitor-research": "Competitive Research Agent",
    "startup-portrait": "Startup Analysis & Profiling",
  };

  // Check for special cases
  const idWithoutNumber = cookbookId.replace(/^\d+-/, "");
  if (specialCases[idWithoutNumber]) {
    return specialCases[idWithoutNumber];
  }

  // Clean up the raw name - remove unwanted words
  let title = rawName
    .replace(/[-_]/g, " ")
    .replace(/\b(agent|bot|cookbook|claude|anthropic|code)\b/gi, "")
    .trim();

  // If title is empty after cleanup, use cookbook ID
  if (!title) {
    title = cookbookId
      .replace(/^\d+-/, "")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Capitalize each word properly
  title = title.replace(/\b\w/g, (char) => char.toUpperCase());

  // Handle common abbreviations
  title = title
    .replace(/\bApi\b/g, "API")
    .replace(/\bHf\b/g, "Hugging Face")
    .replace(/\bAi\b/g, "AI")
    .replace(/\bMl\b/g, "ML")
    .replace(/\bUi\b/g, "UI")
    .replace(/\bGpt\b/g, "GPT");

  return title.trim() || cookbookId;
}

// Enrich brief descriptions
function enrichDescription(
  desc: string,
  cookbookName: string,
  cookbookId: string,
): string {
  // If description is too short (less than 50 chars), enrich it
  if (desc.length < 50) {
    const idWithoutNumber = cookbookId.replace(/^\d+-/, "");

    // Context-specific enrichments based on cookbook type
    const enrichments: Record<string, string> = {
      intro: `${desc} Perfect for beginners looking to understand the fundamentals of VM0 agent development.`,
      "writing-agent": `${desc} Automate content creation workflows with AI-powered writing capabilities.`,
      "fetch-stores": `${desc} Build robust data pipelines that integrate with multiple data sources and storage systems.`,
      "content-farm": `${desc} Scale your content production with automated generation and publishing workflows.`,
      "hf-trainer": `${desc} Train and fine-tune machine learning models efficiently using Hugging Face infrastructure.`,
      "tiktok-influencer": `${desc} Create engaging social media content and grow your TikTok presence with automation.`,
      "firecrawl-summary": `${desc} Extract and summarize web content at scale using advanced crawling techniques.`,
      "competitor-research": `${desc} Gather competitive intelligence and market insights with automated research tools.`,
      "github-agent": `${desc} Streamline your development workflow with automated GitHub operations and integrations.`,
      "startup-portrait": `${desc} Analyze and profile startups to make informed investment and partnership decisions.`,
      "daily-data-report": `${desc} Generate comprehensive daily reports aggregating data from multiple analytics sources.`,
      "intro-skills": `${desc} Discover how to extend agent capabilities with pre-built skills and custom integrations.`,
    };

    if (enrichments[idWithoutNumber]) {
      return enrichments[idWithoutNumber];
    }

    // Generic enrichment for unknown cookbooks
    return `${desc} This cookbook provides step-by-step guidance for building ${cookbookName.toLowerCase()} with VM0.`;
  }

  return desc;
}

// Optimize description for readability
function optimizeDescription(
  rawDescription: string,
  cookbookName: string = "",
  cookbookId: string = "",
): string {
  let desc = rawDescription.replace(/["']/g, "").replace(/\s+/g, " ").trim();

  // Replace common patterns with more readable versions
  desc = desc
    .replace(/\bagent that\b/gi, "automation that")
    .replace(/\bbot that\b/gi, "automation that")
    .replace(/\bagent for\b/gi, "template for")
    .replace(/\bvm0\b/gi, "VM0")
    .replace(/\bclaude\b/gi, "AI")
    .replace(/\banthropics?\b/gi, "");

  // Remove extra spaces from replacements
  desc = desc.replace(/\s+/g, " ").trim();

  // Ensure it starts with capital letter
  if (desc) {
    desc = desc.charAt(0).toUpperCase() + desc.slice(1);
  }

  // Enrich if too brief
  if (cookbookName && cookbookId) {
    desc = enrichDescription(desc, cookbookName, cookbookId);
  }

  // Ensure it ends with a period
  if (desc && !desc.match(/[.!?]$/)) {
    desc += ".";
  }

  return desc;
}

// Auto-detect icon based on cookbook name and description
function detectIcon(id: string, name: string, description: string): string {
  const text = `${id} ${name} ${description}`.toLowerCase();

  const iconKeywords: Record<string, string[]> = {
    book: ["intro", "getting started", "tutorial", "guide", "basics"],
    pen: ["write", "writing", "author", "blog", "content"],
    database: ["data", "store", "fetch", "api", "database"],
    layers: ["farm", "multiple", "batch", "workflow"],
    cpu: ["train", "model", "ml", "ai", "hf", "hugging"],
    video: ["tiktok", "video", "media", "influencer"],
    globe: ["web", "crawl", "scrape", "firecrawl", "website"],
    search: ["research", "competitor", "analysis", "search"],
    git: ["github", "git", "repository", "code"],
    briefcase: ["startup", "business", "portrait", "company"],
    chart: ["report", "analytics", "stats", "metrics", "dashboard"],
    skills: ["skill", "integration", "plugin", "tool"],
  };

  for (const [icon, keywords] of Object.entries(iconKeywords)) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      return icon;
    }
  }

  return "book"; // Default icon
}

// Parse vm0.yaml content to extract metadata
async function parseCookbookMetadata(
  cookbookId: string,
): Promise<CookbookMetadata> {
  // Try to fetch vm0.yaml
  const yamlResponse = await fetch(
    `https://raw.githubusercontent.com/vm0-ai/vm0-cookbooks/main/${cookbookId}/vm0.yaml`,
    {
      headers: { "User-Agent": "VM0-Website" },
      next: { revalidate: 3600 },
    },
  );

  if (!yamlResponse.ok) {
    // Fallback: generate basic metadata from ID
    const rawName = cookbookId
      .replace(/^\d+-/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const name = optimizeTitle(rawName, cookbookId);
    const description = optimizeDescription(
      `Learn how to build ${name.toLowerCase()}`,
      name,
      cookbookId,
    );

    return {
      id: cookbookId,
      name,
      description,
      icon: detectIcon(cookbookId, name, description),
      docsUrl: `https://github.com/vm0-ai/vm0-cookbooks/tree/main/${cookbookId}`,
    };
  }

  const yamlContent = await yamlResponse.text();

  // Extract agent name and description from YAML
  const nameMatch = yamlContent.match(/name:\s*["']?([^"'\n]+)["']?/);
  const descMatch = yamlContent.match(/description:\s*["']?([^"'\n]+)["']?/i);

  let rawName = nameMatch ? nameMatch[1]?.trim() : "";
  let rawDescription = descMatch ? descMatch[1]?.trim() : "";

  // If no name found, generate from ID
  if (!rawName) {
    rawName = cookbookId
      .replace(/^\d+-/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Optimize title and description
  const name = optimizeTitle(rawName, cookbookId);

  // If no description found, generate basic one
  if (!rawDescription) {
    rawDescription = `Learn how to build ${name.toLowerCase()}`;
  }

  const description = optimizeDescription(rawDescription, name, cookbookId);
  const icon = detectIcon(cookbookId, name, description);

  return {
    id: cookbookId,
    name,
    description,
    icon,
    docsUrl: `https://github.com/vm0-ai/vm0-cookbooks/tree/main/${cookbookId}`,
  };
}

async function fetchCookbooksList(): Promise<string[]> {
  const response = await fetch(
    "https://api.github.com/repos/vm0-ai/vm0-cookbooks/contents",
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "VM0-Website",
      },
      next: { revalidate: 3600 },
    },
  );

  if (!response.ok) {
    throw new Error("Failed to fetch cookbooks list");
  }

  const contents = (await response.json()) as GitHubContent[];

  return contents
    .filter((item) => item.type === "dir" && item.name !== "docs")
    .map((item) => item.name)
    .sort(); // Sort alphabetically
}

export async function GET() {
  const cookbookIds = await fetchCookbooksList();

  // Fetch metadata for all cookbooks in parallel
  const cookbooksPromises = cookbookIds.map((id) => parseCookbookMetadata(id));
  const cookbooks = await Promise.all(cookbooksPromises);

  return NextResponse.json({
    success: true,
    total: cookbooks.length,
    cookbooks,
  });
}
