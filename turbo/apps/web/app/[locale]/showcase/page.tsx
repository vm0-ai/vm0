import type { Metadata } from "next";
import type { Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";
import { ShowcaseClient } from "./ShowcaseClient";

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    prompt?: string | string[];
    website?: string | string[];
  }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;

  return {
    title: "Website Design Showcase - VM0",
    description:
      "Preview a website design example and remix its prompt in Zero.",
    alternates: buildLocaleAlternates("/showcase", locale as Locale),
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default async function ShowcasePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const prompt = Array.isArray(params.prompt)
    ? (params.prompt[0] ?? "")
    : (params.prompt ?? "");
  const website = Array.isArray(params.website)
    ? (params.website[0] ?? null)
    : (params.website ?? null);

  return (
    <>
      <style>{`.header-container{display:none}`}</style>
      <ShowcaseClient prompt={prompt} websiteUrl={website} />
    </>
  );
}
