import { draftMode } from "next/headers";
import { redirect } from "next/navigation";
import { NextRequest } from "next/server";
import { locales, type Locale } from "../../../i18n";
import { env } from "../../../src/env";
import { getPost } from "../../lib/blog";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");
  const slug = searchParams.get("slug");
  const locale = searchParams.get("locale") ?? "en";

  const expectedSecret = env().STRAPI_PREVIEW_SECRET;
  if (!expectedSecret) {
    return new Response("Preview is not configured", { status: 501 });
  }
  if (secret !== expectedSecret) {
    return new Response("Invalid preview secret", { status: 401 });
  }
  if (!slug) {
    return new Response("Missing slug", { status: 400 });
  }
  if (!locales.includes(locale as Locale)) {
    return new Response("Invalid locale", { status: 400 });
  }

  const post = await getPost(slug, locale, { draft: true });
  if (!post) {
    return new Response("Draft not found", { status: 404 });
  }

  (await draftMode()).enable();
  redirect(`/${locale}/blog/posts/${slug}`);
}
