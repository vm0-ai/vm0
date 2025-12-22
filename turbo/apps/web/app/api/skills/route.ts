import { NextResponse } from 'next/server';

export const runtime = 'edge';
export const revalidate = 3600; // Cache for 1 hour

interface SkillMetadata {
  name: string;
  description: string;
  category: string;
  logo?: string;
  docsUrl?: string;
  setupRequired?: string[];
}

// Mapping of skill names to categories and metadata
const SKILL_CATEGORIES: Record<string, { category: string; logo?: string }> = {
  // Communication & Messaging
  slack: { category: 'Communication', logo: 'https://cdn.simpleicons.org/slack' },
  'slack-webhook': { category: 'Communication', logo: 'https://cdn.simpleicons.org/slack' },
  chatwoot: { category: 'Communication', logo: 'https://cdn.simpleicons.org/chatwoot' },
  lark: { category: 'Communication', logo: 'https://cdn.simpleicons.org/lark' },
  zeptomail: { category: 'Communication', logo: 'https://cdn.simpleicons.org/zoho' },

  // Search & Information
  'brave-search': { category: 'Search', logo: 'https://cdn.simpleicons.org/brave' },
  tavily: { category: 'Search', logo: 'https://www.tavily.com/favicon.ico' },
  perplexity: { category: 'Search', logo: 'https://www.perplexity.ai/favicon.ico' },
  serpapi: { category: 'Search', logo: 'https://serpapi.com/favicon.ico' },
  'rss-fetch': { category: 'Search', logo: 'https://cdn.simpleicons.org/rss' },

  // Web Scraping & Data
  firecrawl: { category: 'Web Scraping', logo: 'https://www.firecrawl.dev/favicon.ico' },
  browserless: { category: 'Web Scraping', logo: 'https://www.browserless.io/favicon.ico' },
  scrapeninja: { category: 'Web Scraping', logo: 'https://scrapeninja.net/favicon.ico' },
  apify: { category: 'Web Scraping', logo: 'https://cdn.simpleicons.org/apify' },
  'bright-data': { category: 'Web Scraping', logo: 'https://brightdata.com/favicon.ico' },

  // Development Tools
  github: { category: 'Development', logo: 'https://cdn.simpleicons.org/github' },
  'github-copilot': { category: 'Development', logo: 'https://cdn.simpleicons.org/githubcopilot' },
  deepseek: { category: 'Development', logo: 'https://www.deepseek.com/favicon.ico' },
  'devto-publish': { category: 'Development', logo: 'https://cdn.simpleicons.org/devdotto' },

  // Cloud & Storage
  minio: { category: 'Cloud Storage', logo: 'https://cdn.simpleicons.org/minio' },
  qdrant: { category: 'Cloud Storage', logo: 'https://cdn.simpleicons.org/qdrant' },
  cloudinary: { category: 'Cloud Storage', logo: 'https://cdn.simpleicons.org/cloudinary' },
  supadata: { category: 'Cloud Storage', logo: 'https://supadata.ai/favicon.ico' },

  // AI & Media Generation
  elevenlabs: { category: 'AI & Media', logo: 'https://elevenlabs.io/favicon.ico' },
  'fal-image': { category: 'AI & Media', logo: 'https://fal.ai/favicon.ico' },
  runway: { category: 'AI & Media', logo: 'https://runwayml.com/favicon.ico' },
  htmlcsstoimage: { category: 'AI & Media', logo: 'https://htmlcsstoimage.com/favicon.ico' },

  // Project Management
  notion: { category: 'Productivity', logo: 'https://cdn.simpleicons.org/notion' },
  monday: { category: 'Productivity', logo: 'https://cdn.simpleicons.org/monday' },
  instantly: { category: 'Productivity', logo: 'https://instantly.ai/favicon.ico' },

  // Document Processing
  pdfco: { category: 'Documents', logo: 'https://pdf.co/favicon.ico' },
  pdforge: { category: 'Documents', logo: 'https://pdforge.com/favicon.ico' },
  zapsign: { category: 'Documents', logo: 'https://zapsign.com/favicon.ico' },

  // Analytics & Monitoring
  plausible: { category: 'Analytics', logo: 'https://cdn.simpleicons.org/plausibleanalytics' },
  cronlytic: { category: 'Analytics', logo: 'https://cronlytic.com/favicon.ico' },

  // Content Publishing
  qiita: { category: 'Content', logo: 'https://cdn.simpleicons.org/qiita' },
  instagram: { category: 'Content', logo: 'https://cdn.simpleicons.org/instagram' },
  imgur: { category: 'Content', logo: 'https://cdn.simpleicons.org/imgur' },

  // Utilities
  shortio: { category: 'Utilities', logo: 'https://short.io/favicon.ico' },
  minimax: { category: 'Utilities', logo: 'https://www.minimaxi.com/favicon.ico' },
};

async function fetchSkillsList(): Promise<string[]> {
  const response = await fetch(
    'https://api.github.com/repos/vm0-ai/vm0-skills/contents',
    {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'VM0-Website',
      },
      next: { revalidate: 3600 },
    }
  );

  if (!response.ok) {
    throw new Error('Failed to fetch skills list');
  }

  const contents = await response.json();
  return contents
    .filter((item: any) => item.type === 'dir' && item.name !== 'docs')
    .map((item: any) => item.name);
}

async function fetchSkillMetadata(skillName: string): Promise<SkillMetadata | null> {
  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/${skillName}/SKILL.md`,
      {
        headers: {
          'User-Agent': 'VM0-Website',
        },
        next: { revalidate: 3600 },
      }
    );

    if (!response.ok) {
      return null;
    }

    const content = await response.text();

    // Parse the markdown content to extract description
    const lines = content.split('\n');
    let description = '';

    // Look for the first paragraph after the title
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.startsWith('#') && !line.startsWith('-') && !line.startsWith('*')) {
        description = line;
        break;
      }
    }

    const categoryInfo = SKILL_CATEGORIES[skillName] || { category: 'Other' };

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
    const skillsPromises = skillNames.map(name => fetchSkillMetadata(name));
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
    const skillsByCategory = skills.reduce((acc, skill) => {
      if (!acc[skill.category]) {
        acc[skill.category] = [];
      }
      acc[skill.category].push(skill);
      return acc;
    }, {} as Record<string, SkillMetadata[]>);

    return NextResponse.json({
      success: true,
      total: skills.length,
      categories: Object.keys(skillsByCategory).length,
      skillsByCategory,
      skills,
    });
  } catch (error) {
    console.error('Error fetching skills:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch skills',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
