import { Metadata } from "next";
import SkillsClient from "./SkillsClient";

export const metadata: Metadata = {
  title: "VM0 Agent Skills - Pre-built Integrations",
  description:
    "Explore our comprehensive collection of pre-built skills for AI agents. Connect to 50+ services including Slack, GitHub, Notion, and more.",
  openGraph: {
    title: "VM0 Agent Skills - Pre-built Integrations",
    description:
      "Explore our comprehensive collection of pre-built skills for AI agents.",
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
  try {
    // Import the API handler directly for server-side rendering
    // This avoids issues with VERCEL_URL vs custom domain
    const { GET } = await import("../../api/skills/route");
    const response = await GET();
    const data = await response.json();
    return data.skills || [];
  } catch (error) {
    console.error("Error fetching skills:", error);
    return [];
  }
}

export default async function SkillsPage() {
  const skills = await getSkills();

  return <SkillsClient initialSkills={skills} />;
}
