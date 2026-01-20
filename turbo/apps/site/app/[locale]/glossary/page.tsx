import { Metadata } from "next";
import GlossaryClient from "./GlossaryClient";

export const metadata: Metadata = {
  title: "Agent Building Glossary - VM0",
  description:
    "Comprehensive glossary of agent building terms and concepts. Learn about agents, skills, tools, observability, and VM0-specific infrastructure.",
  openGraph: {
    title: "Agent Building Glossary - VM0",
    description: "Comprehensive glossary of agent building terms and concepts.",
    type: "website",
  },
};

export default function GlossaryPage() {
  return <GlossaryClient />;
}
