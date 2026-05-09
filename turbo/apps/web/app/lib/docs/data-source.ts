import type {
  DocsNavigationPage,
  DocsNavigationSection,
  DocsPage,
} from "./types";
import { getDocsPageByPathFromStrapi, getDocsPagesFromStrapi } from "./strapi";

export async function getDocsPages(locale: string = "en"): Promise<DocsPage[]> {
  return getDocsPagesFromStrapi(locale);
}

export async function getDocsPage(
  path: string,
  locale: string = "en",
  options: { draft?: boolean } = {},
): Promise<DocsPage | null> {
  return getDocsPageByPathFromStrapi(path, locale, options);
}

export function buildDocsNavigation(
  pages: DocsPage[],
): DocsNavigationSection[] {
  const sections = new Map<string, DocsNavigationSection>();

  for (const page of pages) {
    if (!page.path) continue;

    const existing = sections.get(page.section.slug);
    const section =
      existing ??
      ({
        title: page.section.title,
        slug: page.section.slug,
        order: page.section.order,
        pages: [],
      } satisfies DocsNavigationSection);

    const navPage: DocsNavigationPage = {
      path: page.path,
      title: page.title,
      description: page.description,
      order: page.order,
    };

    section.pages.push(navPage);
    sections.set(section.slug, section);
  }

  return Array.from(sections.values())
    .map((section) => {
      return {
        ...section,
        pages: section.pages.sort((a, b) => {
          return a.order - b.order || a.title.localeCompare(b.title);
        }),
      };
    })
    .sort((a, b) => {
      return a.order - b.order || a.title.localeCompare(b.title);
    });
}

export async function getDocsNavigation(
  locale: string = "en",
): Promise<DocsNavigationSection[]> {
  return buildDocsNavigation(await getDocsPages(locale));
}

export async function getDocsAvailableLocales(
  path: string,
  supportedLocales: readonly string[],
): Promise<string[]> {
  const checks = await Promise.all(
    supportedLocales.map(async (locale) => {
      const page = await getDocsPage(path, locale);
      return page ? locale : null;
    }),
  );

  return checks.filter((locale): locale is string => {
    return locale !== null;
  });
}
