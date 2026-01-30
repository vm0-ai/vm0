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
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Agent Building Glossary - VM0",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Building Glossary - VM0",
    description: "Comprehensive glossary of agent building terms and concepts.",
    images: ["/og-image.png"],
    creator: "@vm0_ai",
  },
};

export default function GlossaryPage() {
  return <GlossaryClient />;
}
