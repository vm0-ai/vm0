import { Metadata } from "next";
import SkillsClient from "./SkillsClient";
import { GET } from "../../api/web/skills/route";

export const metadata: Metadata = {
  title: "VM0 Agent Skills - Pre-built Integrations",
  description:
    "Explore our comprehensive collection of 54+ pre-built skills for AI agents. Connect to services including Slack, GitHub, Notion, Discord, Linear, and more.",
  openGraph: {
    title: "VM0 Agent Skills - Pre-built Integrations",
    description:
      "Explore our comprehensive collection of 54+ pre-built skills for AI agents.",
    type: "website",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "VM0 Agent Skills - Pre-built Integrations",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "VM0 Agent Skills - Pre-built Integrations",
    description:
      "Explore our comprehensive collection of 54+ pre-built skills for AI agents.",
    images: ["/og-image.png"],
    creator: "@vm0_ai",
  },
};

// Static generation at build time - skills data fetched once during build
export const dynamic = "force-static";

interface SkillMetadata {
  name: string;
  description: string;
  category: string;
  logo?: string;
  docsUrl?: string;
}

async function getSkills(): Promise<SkillMetadata[]> {
  // Call the API handler directly for server-side rendering
  // This avoids issues with VERCEL_URL vs custom domain
  const response = await GET();
  const data = await response.json();
  return data.skills || [];
}

export default async function SkillsPage() {
  const skills = await getSkills();

  return <SkillsClient initialSkills={skills} />;
}
