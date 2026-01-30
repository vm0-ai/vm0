import { generateOGImage } from "fumadocs-ui/og";
import { source } from "@/lib/source";
import { notFound } from "next/navigation";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params;
  // Remove 'og.png' from end of slug
  const pageSlug = slug.slice(0, -1);
  const page = source.getPage(pageSlug);

  if (!page) notFound();

  return generateOGImage({
    title: page.data.title,
    description: page.data.description,
    site: "VM0 Docs",
  });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: [...page.slugs, "og.png"],
  }));
}
