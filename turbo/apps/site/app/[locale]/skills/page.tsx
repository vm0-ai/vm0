import { Metadata } from "next";
import SkillsClient from "./SkillsClient";
import { getSkills } from "./get-skills";

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

// Static generation at build time - skills data fetched once during build
export const dynamic = "force-static";

export default async function SkillsPage() {
  const skills = await getSkills();

  return <SkillsClient initialSkills={skills} />;
}
