import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { GET as getCompose } from "../../../../api/agent/composes/route";
import {
  createTestRequest,
  createTestCliToken,
  seedTestSkill,
  clearSkillsData,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { Sandbox } from "@e2b/code-interpreter";

vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    create: vi.fn().mockResolvedValue({
      sandboxId: "mock-sandbox-id",
      files: { write: vi.fn().mockResolvedValue(undefined) },
      commands: { run: vi.fn().mockResolvedValue({ exitCode: 0 }) },
    }),
    connect: vi.fn(),
  },
}));

const context = testContext();

let testCliToken: string;

function makeContent(overrides: Record<string, unknown> = {}) {
  return {
    version: "1",
    agents: {
      "test-agent": {
        framework: "claude-code",
        description: "A test agent",
        ...overrides,
      },
    },
  };
}

function postComposeJob(body: Record<string, unknown>, token: string) {
  return POST(
    createTestRequest("http://localhost:3000/api/compose/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

function getComposeByName(name: string, token: string) {
  return getCompose(
    createTestRequest(`http://localhost:3000/api/agent/composes?name=${name}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

describe("Server-side compose", () => {
  beforeEach(async () => {
    context.setupMocks();
    await clearSkillsData();
    const user = await context.setupUser();
    testCliToken = await createTestCliToken(user.userId);
    vi.mocked(Sandbox.create).mockClear();
  });

  describe("happy path", () => {
    it("should complete synchronously when all skills are cached", async () => {
      await seedTestSkill({
        url: "https://github.com/vm0-ai/vm0-skills/tree/main/slack",
        name: "slack",
        fullPath: "vm0-ai/vm0-skills/tree/main/slack",
        frontmatter: {
          name: "Slack",
          description: "Slack integration",
          vm0_secrets: ["SLACK_BOT_TOKEN"],
          vm0_vars: ["LOG_LEVEL"],
        },
      });

      const content = makeContent({ skills: ["slack"] });
      const response = await postComposeJob(
        { content, instructions: "# My Instructions" },
        testCliToken,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("completed");
      expect(data.source).toBe("platform");
      expect(data.result).toBeDefined();
      expect(data.result.composeId).toBeDefined();
      expect(data.result.composeName).toBe("test-agent");
      expect(data.result.versionId).toMatch(/^[a-f0-9]{64}$/);
      expect(data.completedAt).toBeDefined();

      // Verify no sandbox was spawned
      expect(Sandbox.create).not.toHaveBeenCalled();

      // Verify compose record via API
      const composeResponse = await getComposeByName(
        "test-agent",
        testCliToken,
      );
      expect(composeResponse.status).toBe(200);
      const compose = await composeResponse.json();
      expect(compose.name).toBe("test-agent");
      expect(compose.headVersionId).toBe(data.result.versionId);
    });

    it("should complete synchronously when agent has no skills", async () => {
      const content = makeContent();
      const response = await postComposeJob({ content }, testCliToken);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("completed");
      expect(data.result.composeName).toBe("test-agent");

      expect(Sandbox.create).not.toHaveBeenCalled();
    });
  });

  describe("fallback to sandbox", () => {
    it("should fall back when skill is not cached", async () => {
      const content = makeContent({
        skills: ["https://github.com/vm0-ai/vm0-skills/tree/main/uncached"],
      });
      const response = await postComposeJob({ content }, testCliToken);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("pending");
      expect(data.source).toBe("platform");

      expect(Sandbox.create).toHaveBeenCalled();
    });

    it("should always use sandbox for GitHub URL mode", async () => {
      const response = await postComposeJob(
        { githubUrl: "https://github.com/owner/repo" },
        testCliToken,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("pending");
      expect(data.source).toBe("github");
    });
  });

  describe("idempotency", () => {
    it("should return existing active job instead of creating server-side compose", async () => {
      // Create a sandbox job first (uncached skill triggers sandbox)
      const content = makeContent({
        skills: ["https://github.com/vm0-ai/vm0-skills/tree/main/uncached"],
      });
      const response1 = await postComposeJob({ content }, testCliToken);
      expect(response1.status).toBe(201);
      const data1 = await response1.json();
      expect(data1.status).toBe("pending");

      // Second request should return existing job, even though we could do server-side
      const content2 = makeContent();
      const response2 = await postComposeJob(
        { content: content2 },
        testCliToken,
      );
      expect(response2.status).toBe(200);
      const data2 = await response2.json();
      expect(data2.jobId).toBe(data1.jobId);
    });
  });

  describe("skill variable merging", () => {
    it("should merge skill variables from cached frontmatter", async () => {
      await seedTestSkill({
        url: "https://github.com/vm0-ai/vm0-skills/tree/main/slack",
        name: "slack",
        fullPath: "vm0-ai/vm0-skills/tree/main/slack",
        frontmatter: {
          name: "Slack",
          vm0_secrets: ["SLACK_BOT_TOKEN"],
          vm0_vars: ["LOG_LEVEL"],
        },
      });

      const content = makeContent({
        skills: ["slack"],
        environment: { EXISTING_VAR: "keep-me" },
      });
      const response = await postComposeJob({ content }, testCliToken);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("completed");

      // Verify the compose version has merged environment via compose API
      const composeResponse = await getComposeByName(
        "test-agent",
        testCliToken,
      );
      const compose = await composeResponse.json();
      const agentEnv =
        compose.content?.agents?.["test-agent"]?.environment ?? {};
      expect(agentEnv["EXISTING_VAR"]).toBe("keep-me");
      expect(agentEnv["SLACK_BOT_TOKEN"]).toBe(
        "${{ secrets.SLACK_BOT_TOKEN }}",
      );
      expect(agentEnv["LOG_LEVEL"]).toBe("${{ vars.LOG_LEVEL }}");
    });

    it("should not overwrite existing environment variables", async () => {
      await seedTestSkill({
        url: "https://github.com/vm0-ai/vm0-skills/tree/main/slack",
        name: "slack",
        fullPath: "vm0-ai/vm0-skills/tree/main/slack",
        frontmatter: {
          name: "Slack",
          vm0_secrets: ["SLACK_BOT_TOKEN"],
          vm0_vars: [],
        },
      });

      const content = makeContent({
        skills: ["slack"],
        environment: { SLACK_BOT_TOKEN: "my-custom-value" },
      });
      const response = await postComposeJob({ content }, testCliToken);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("completed");

      const composeResponse = await getComposeByName(
        "test-agent",
        testCliToken,
      );
      const compose = await composeResponse.json();
      expect(
        compose.content?.agents?.["test-agent"]?.environment?.[
          "SLACK_BOT_TOKEN"
        ],
      ).toBe("my-custom-value");
    });
  });

  describe("instructions upload", () => {
    it("should upload instructions via server-side path", async () => {
      const content = makeContent();
      const response = await postComposeJob(
        { content, instructions: "# Be helpful" },
        testCliToken,
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("completed");

      // Verify S3 upload was called for instructions
      expect(context.mocks.s3.putS3Object).toHaveBeenCalled();
    });

    it("should succeed without instructions", async () => {
      const content = makeContent();
      const response = await postComposeJob({ content }, testCliToken);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("completed");
    });
  });

  describe("compose record", () => {
    it("should create compose record accessible via API", async () => {
      const content = makeContent({
        environment: { UNIQUE_KEY: `test-${Date.now()}` },
      });
      const response = await postComposeJob({ content }, testCliToken);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("completed");

      // Verify compose record via GET /api/agent/composes?name=
      const composeResponse = await getComposeByName(
        "test-agent",
        testCliToken,
      );
      expect(composeResponse.status).toBe(200);
      const compose = await composeResponse.json();
      expect(compose.id).toBe(data.result.composeId);
      expect(compose.name).toBe("test-agent");
      expect(compose.headVersionId).toBe(data.result.versionId);
      expect(compose.content).toBeDefined();
    });

    it("should reuse existing compose record for same agent name", async () => {
      const content = makeContent();

      // First compose
      const response1 = await postComposeJob({ content }, testCliToken);
      expect(response1.status).toBe(201);
      const data1 = await response1.json();

      // Second compose with different environment (creates new version)
      const content2 = makeContent({ environment: { NEW: "value" } });
      const response2 = await postComposeJob(
        { content: content2 },
        testCliToken,
      );
      expect(response2.status).toBe(201);
      const data2 = await response2.json();

      // Same composeId, different versionId
      expect(data2.result.composeId).toBe(data1.result.composeId);
      expect(data2.result.versionId).not.toBe(data1.result.versionId);
    });
  });
});
