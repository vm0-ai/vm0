export interface DocsSection {
  title: string;
  slug: string;
  order: number;
}

export interface DocsPage {
  path: string;
  slug: string;
  title: string;
  description: string;
  content: string;
  section: DocsSection;
  order: number;
  publishedAt: string;
  updatedAt: string;
  readTime: string;
}

export interface DocsNavigationPage {
  path: string;
  title: string;
  description: string;
  order: number;
}

export interface DocsNavigationSection {
  title: string;
  slug: string;
  order: number;
  pages: DocsNavigationPage[];
}
