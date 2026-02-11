import { env } from "../../src/env";

export async function fetchClaudeCodeVersion(): Promise<string | undefined> {
  const url = env().CLAUDE_CODE_VERSION_URL;
  if (!url) {
    throw new Error("CLAUDE_CODE_VERSION_URL environment variable is required");
  }

  const res = await fetch(url, {
    next: { revalidate: 3600 }, // 1 hour cache
  });

  if (!res.ok) {
    return undefined;
  }

  const version = await res.text();
  return `v${version.trim()}`;
}
