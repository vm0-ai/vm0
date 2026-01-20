interface SkillMetadata {
  name: string;
  description: string;
  category: string;
  logo?: string;
  docsUrl?: string;
}

export async function getSkills(): Promise<SkillMetadata[]> {
  // Fetch skills from web app API
  const webAppUrl = process.env.WEB_APP_URL || "http://localhost:3000";
  const response = await fetch(`${webAppUrl}/api/web/skills`, {
    next: { revalidate: 3600 },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch skills: ${response.statusText}`);
  }

  const data = await response.json();
  return data.skills || [];
}
