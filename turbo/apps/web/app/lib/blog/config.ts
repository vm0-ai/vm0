import { env } from "../../../src/env";

export function getBlogBaseUrl(): string {
  const url = env().NEXT_PUBLIC_BASE_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_BASE_URL environment variable is not configured",
    );
  }
  return url;
}
