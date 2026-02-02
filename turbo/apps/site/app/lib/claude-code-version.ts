const CLAUDE_CODE_VERSION_URL =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest";

export async function fetchClaudeCodeVersion(): Promise<string | undefined> {
  try {
    const res = await fetch(CLAUDE_CODE_VERSION_URL, {
      next: { revalidate: 3600 }, // 1 hour cache
    });

    if (!res.ok) {
      return undefined;
    }

    const version = await res.text();
    return `v${version.trim()}`;
  } catch {
    return undefined;
  }
}
