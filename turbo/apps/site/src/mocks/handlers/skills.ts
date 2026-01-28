import { http, HttpResponse } from "msw";
import { SKILLS_API_URL } from "../../../app/[locale]/skills/constants";

interface SkillMetadata {
  name: string;
  description: string;
  category: string;
  logo?: string;
  docsUrl?: string;
}

const mockSkills: SkillMetadata[] = [
  {
    name: "Slack",
    description:
      "Send messages, create channels, and manage your Slack workspace programmatically",
    category: "Communication",
    logo: "/skills/slack.svg",
    docsUrl: "https://docs.vm0.ai/docs/agent-skills/slack",
  },
  {
    name: "GitHub",
    description:
      "Automate GitHub operations using gh CLI - manage repositories, issues, pull requests, releases, and workflows",
    category: "Development",
    logo: "/skills/github.svg",
    docsUrl: "https://docs.vm0.ai/docs/agent-skills/github",
  },
  {
    name: "Notion",
    description:
      "Create, read, and update pages in your Notion workspace for knowledge management",
    category: "Productivity",
    logo: "/skills/notion.svg",
    docsUrl: "https://docs.vm0.ai/docs/agent-skills/notion",
  },
];

export const skillsHandlers = [
  // GET /api/web/skills - Return mock skills list
  http.get(SKILLS_API_URL, () => {
    const skillsByCategory = mockSkills.reduce(
      (acc, skill) => {
        if (!acc[skill.category]) {
          acc[skill.category] = [];
        }
        acc[skill.category]!.push(skill);
        return acc;
      },
      {} as Record<string, SkillMetadata[]>,
    );

    return HttpResponse.json({
      success: true,
      total: mockSkills.length,
      categories: Object.keys(skillsByCategory).length,
      skillsByCategory,
      skills: mockSkills,
    });
  }),

  // Error scenario handler (can be used by calling server.use())
  http.get(`${SKILLS_API_URL}/error`, () => {
    return HttpResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }),
];
