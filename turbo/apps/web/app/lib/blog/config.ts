// Returns the base URL for blog content
function getBlogBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_BASE_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_BASE_URL environment variable is not configured",
    );
  }
  return url;
}

export const BLOG_BASE_URL = getBlogBaseUrl();
