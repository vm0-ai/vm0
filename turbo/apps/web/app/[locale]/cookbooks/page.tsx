import { Metadata } from "next";
import CookbooksClient from "./CookbooksClient";

export const metadata: Metadata = {
  title: "VM0 Cookbooks - Agent Templates & Examples",
  description:
    "Explore our collection of ready-to-use agent cookbooks. Learn how to build agents for content generation, data analysis, automation, and more.",
  openGraph: {
    title: "VM0 Cookbooks - Agent Templates & Examples",
    description:
      "Explore our collection of ready-to-use agent cookbooks and templates.",
    type: "website",
  },
};

// Revalidate every hour
export const revalidate = 3600;

interface CookbookMetadata {
  id: string;
  name: string;
  description: string;
  icon: string;
  docsUrl: string;
}

async function getCookbooks(): Promise<CookbookMetadata[]> {
  // Import the API handler directly for server-side rendering
  const { GET } = await import("../../api/web/cookbooks/route");
  const response = await GET();
  const data = await response.json();
  return data.cookbooks || [];
}

export default async function CookbooksPage() {
  const cookbooks = await getCookbooks();

  return <CookbooksClient initialCookbooks={cookbooks} />;
}
