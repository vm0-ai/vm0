import { http, HttpResponse } from "msw";

// Default mock responses for GitHub API
const defaultSkillListing = [
  { name: "SKILL.md", type: "file", download_url: null },
];

const defaultSkillContent = `---
name: vm0-agent-builder
description: Guide for building VM0 agents with Claude's help
---
# VM0 Agent Builder
Test content for skill`;

export const githubHandlers = [
  // GitHub API - directory listing
  http.get(
    "https://api.github.com/repos/vm0-ai/vm0/contents/docs/vm0-agent-builder",
    () => {
      return HttpResponse.json(defaultSkillListing);
    },
  ),

  // GitHub Raw - file content
  http.get(
    "https://raw.githubusercontent.com/vm0-ai/vm0/main/docs/vm0-agent-builder/SKILL.md",
    () => {
      return HttpResponse.text(defaultSkillContent);
    },
  ),
];
