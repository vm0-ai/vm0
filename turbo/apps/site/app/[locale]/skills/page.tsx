import { Metadata } from "next";
import SkillsClient from "./SkillsClient";

export const metadata: Metadata = {
  title: "VM0 Agent Skills - Pre-built Integrations",
  description:
    "Explore our comprehensive collection of 54+ pre-built skills for AI agents. Connect to services including Slack, GitHub, Notion, Discord, Linear, and more.",
  openGraph: {
    title: "VM0 Agent Skills - Pre-built Integrations",
    description:
      "Explore our comprehensive collection of 54+ pre-built skills for AI agents.",
    type: "website",
  },
};

// Revalidate every hour
export const revalidate = 3600;

interface SkillMetadata {
  name: string;
  description: string;
  category: string;
  logo?: string;
  docsUrl?: string;
}

async function getSkills(): Promise<SkillMetadata[]> {
  // Fetch skills from web app API (server-side only)
  const webAppUrl = process.env.WEB_APP_URL || "http://localhost:3000";
  const response = await fetch(`${webAppUrl}/api/web/skills`, {
    next: { revalidate: 3600 },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch skills: ${response.statusText}`);
  }

  const data = await response.json();
  return data.skills || [];
}

export default async function SkillsPage() {
  const skills = await getSkills();

  return <SkillsClient initialSkills={skills} />;
}
