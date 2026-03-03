import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../src/mocks/server";
import { POST } from "../route";
import { GET } from "../[id]/route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { getSkillStorageName } from "@vm0/core";

const SKILL_URL = "https://github.com/vm0-ai/vm0-skills/tree/main/slack";
const SKILL_FULL_PATH = "vm0-ai/vm0-skills/tree/main/slack";

const SKILL_MD_CONTENT = `---
name: Slack
description: Interact with Slack
vm0_secrets:
  - SLACK_BOT_TOKEN
---
# Slack Skill
Send messages to Slack.
`;

const context = testContext();

function setupGitHubMocks() {
  server.use(
    // GitHub Contents API — list skill directory
    http.get(
      "https://api.github.com/repos/vm0-ai/vm0-skills/contents/slack",
      ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("ref") !== "main") {
          return HttpResponse.json({ message: "Not Found" }, { status: 404 });
        }
        return HttpResponse.json([
          {
            name: "SKILL.md",
            path: "slack/SKILL.md",
            type: "file",
            download_url:
              "https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/slack/SKILL.md",
          },
          {
            name: "handler.ts",
            path: "slack/handler.ts",
            type: "file",
            download_url:
              "https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/slack/handler.ts",
          },
        ]);
      },
    ),

    // raw.githubusercontent.com — SKILL.md
    http.get(
      "https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/slack/SKILL.md",
      () => {
        return HttpResponse.text(SKILL_MD_CONTENT);
      },
    ),

    // raw.githubusercontent.com — handler.ts
    http.get(
      "https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/slack/handler.ts",
      () => {
        return HttpResponse.text('export function handler() { return "ok"; }');
      },
    ),
  );
}

describe("Skill Upload on Compose Save", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
    setupGitHubMocks();
  });

  it("should upload skill archive and manifest to S3 when saving compose with skills", async () => {
    const agentName = `test-skill-upload-${Date.now()}`;
    const config = {
      version: "1.0",
      agents: {
        [agentName]: {
          framework: "claude-code" as const,
          skills: [SKILL_URL],
        },
      },
    };

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(201);

    // Verify S3 was called with manifest and archive for the skill
    const storageName = getSkillStorageName(SKILL_FULL_PATH);
    const { s3 } = context.mocks;
    const putCalls = s3.putS3Object.mock.calls;

    const manifestCall = putCalls.find(
      (c) =>
        typeof c[1] === "string" &&
        c[1].includes(storageName) &&
        c[1].endsWith("/manifest.json"),
    );
    const archiveCall = putCalls.find(
      (c) =>
        typeof c[1] === "string" &&
        c[1].includes(storageName) &&
        c[1].endsWith("/archive.tar.gz"),
    );

    expect(manifestCall).toBeDefined();
    expect(archiveCall).toBeDefined();

    // Verify manifest content includes both files
    const manifestBody = manifestCall![2] as string;
    const manifest = JSON.parse(manifestBody);
    expect(manifest.fileCount).toBe(2);
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files.map((f: { path: string }) => f.path).sort()).toEqual([
      "SKILL.md",
      "handler.ts",
    ]);
  });

  it("should skip S3 upload when saving the same compose again", async () => {
    const agentName = `test-skill-dedup-${Date.now()}`;
    const config = {
      version: "1.0",
      agents: {
        [agentName]: {
          framework: "claude-code" as const,
          skills: [SKILL_URL],
        },
      },
    };

    // First save — uploads the skill
    const request1 = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response1 = await POST(request1);
    expect(response1.status).toBe(201);

    // Record how many S3 puts happened
    const putsAfterFirst = context.mocks.s3.putS3Object.mock.calls.length;

    // Second save with same skill — should skip because storage already has HEAD
    const updatedConfig = {
      ...config,
      agents: {
        [agentName]: {
          ...config.agents[agentName],
          description: "Updated",
        },
      },
    };

    const request2 = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: updatedConfig }),
      },
    );

    const response2 = await POST(request2);
    expect(response2.status).toBe(200);

    // No additional S3 puts for the skill
    const putsAfterSecond = context.mocks.s3.putS3Object.mock.calls.length;
    expect(putsAfterSecond).toBe(putsAfterFirst);
  });

  it("should accept bare skill name and normalize to full URL", async () => {
    const agentName = `test-bare-skill-${Date.now()}`;
    const config = {
      version: "1.0",
      agents: {
        [agentName]: {
          framework: "claude-code" as const,
          skills: ["slack"],
        },
      },
    };

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(201);

    // Verify the stored compose has the normalized URL
    const data = await response.json();
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes/${data.composeId}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const composeData = await getResponse.json();

    const agent = composeData.content.agents[agentName];
    expect(agent.skills).toEqual([SKILL_URL]);
  });

  it("should accept plain repo URL and normalize to tree URL", async () => {
    const agentName = `test-repo-url-skill-${Date.now()}`;

    // Mock GitHub API for root-directory skill
    server.use(
      http.get(
        "https://api.github.com/repos/acme/my-skill/contents/",
        ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("ref") !== "main") {
            return HttpResponse.json({ message: "Not Found" }, { status: 404 });
          }
          return HttpResponse.json([
            {
              name: "SKILL.md",
              path: "SKILL.md",
              type: "file",
              download_url:
                "https://raw.githubusercontent.com/acme/my-skill/main/SKILL.md",
            },
          ]);
        },
      ),
      http.get(
        "https://raw.githubusercontent.com/acme/my-skill/main/SKILL.md",
        () => {
          return HttpResponse.text(`---
name: My Skill
description: A root directory skill
---
# My Skill
`);
        },
      ),
    );

    const config = {
      version: "1.0",
      agents: {
        [agentName]: {
          framework: "claude-code" as const,
          skills: ["https://github.com/acme/my-skill"],
        },
      },
    };

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(201);

    // Verify the stored compose has the normalized tree URL
    const data = await response.json();
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes/${data.composeId}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const composeData = await getResponse.json();

    const agent = composeData.content.agents[agentName];
    expect(agent.skills).toEqual([
      "https://github.com/acme/my-skill/tree/main",
    ]);
  });

  it("should merge skill-declared env vars into agent environment", async () => {
    const agentName = `test-skill-env-${Date.now()}`;
    const config = {
      version: "1.0",
      agents: {
        [agentName]: {
          framework: "claude-code" as const,
          skills: [SKILL_URL],
        },
      },
    };

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);

    // Fetch the compose to check the stored environment
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes/${data.composeId}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const composeData = await getResponse.json();

    // SLACK_BOT_TOKEN should be injected from SKILL.md frontmatter
    const agent = composeData.content.agents[agentName];
    expect(agent.environment).toBeDefined();
    expect(agent.environment.SLACK_BOT_TOKEN).toBe(
      "${{ secrets.SLACK_BOT_TOKEN }}",
    );
  });
});
