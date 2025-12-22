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
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/skills`,
      {
        next: { revalidate: 3600 },
      },
    );

    if (!response.ok) {
      console.error("Failed to fetch skills");
      return [];
    }

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
