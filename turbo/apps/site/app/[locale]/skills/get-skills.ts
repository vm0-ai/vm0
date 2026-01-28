interface SkillMetadata {
  name: string;
  description: string;
  category: string;
  logo?: string;
  docsUrl?: string;
}

export async function getSkills(): Promise<SkillMetadata[]> {
  // Fetch skills from web app API
  const response = await fetch("https://www.vm0.ai/api/web/skills");

  if (!response.ok) {
    throw new Error(`Failed to fetch skills: ${response.statusText}`);
  }

  const data = await response.json();
  return data.skills || [];
}
