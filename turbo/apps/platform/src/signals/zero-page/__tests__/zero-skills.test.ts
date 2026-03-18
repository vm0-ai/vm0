import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  zeroAddedSkills$,
  addZeroSkill$,
  saveZeroSkills$,
} from "../zero-skills.ts";
import { setZeroChatAgent$ } from "../zero-nav.ts";

const context = testContext();

interface ComposeJobPayload {
  content: { agents: Record<string, { skills?: string[] }> };
}

function getComposeContent(payload: ComposeJobPayload) {
  return payload.content;
}

function mockComposeApi(content: {
  agents: Record<
    string,
    {
      framework: string;
      skills?: string[];
      metadata?: { displayName?: string; sound?: string };
    }
  >;
}) {
  server.use(
    http.get("*/api/agent/composes/mock-compose-id", () => {
      return HttpResponse.json({
        id: "mock-compose-id",
        name: "test-compose",
        headVersionId: "v1",
        content: { version: "1", ...content },
      });
    }),
  );
}

describe("zeroAddedSkills$", () => {
  it("should seed skills from compose content", async () => {
    mockComposeApi({
      agents: {
        zero: {
          framework: "claude-code",
          skills: [
            "https://github.com/vm0-ai/vm0-skills/tree/main/slack",
            "https://github.com/vm0-ai/vm0-skills/tree/main/github",
          ],
        },
      },
    });

    await setupPage({ context, path: "/", withoutRender: true });

    const skills = await context.store.get(zeroAddedSkills$);
    expect(skills).toStrictEqual(["slack", "github"]);
  });

  it("should return empty array when compose has no skills", async () => {
    mockComposeApi({
      agents: { zero: { framework: "claude-code" } },
    });

    await setupPage({ context, path: "/", withoutRender: true });

    const skills = await context.store.get(zeroAddedSkills$);
    expect(skills).toStrictEqual([]);
  });

  it("should seed skills from sub-agent compose when chat agent is set", async () => {
    const subAgentComposeId = "sub-agent-compose-id";

    // Default agent has slack only
    mockComposeApi({
      agents: {
        zero: {
          framework: "claude-code",
          skills: ["https://github.com/vm0-ai/vm0-skills/tree/main/slack"],
        },
      },
    });

    // Sub-agent has github only
    server.use(
      http.get(`*/api/agent/composes/${subAgentComposeId}`, () => {
        return HttpResponse.json({
          id: subAgentComposeId,
          name: "cycling-coach",
          headVersionId: "v1",
          content: {
            version: "1",
            agents: {
              "cycling-coach": {
                framework: "claude-code",
                skills: [
                  "https://github.com/vm0-ai/vm0-skills/tree/main/github",
                ],
              },
            },
          },
        });
      }),
    );

    await setupPage({
      context,
      path: "/talk/cycling-coach",
      withoutRender: true,
    });
    await context.store.set(setZeroChatAgent$, {
      id: subAgentComposeId,
      name: "cycling-coach",
    });

    const skills = await context.store.get(zeroAddedSkills$);
    expect(skills).toStrictEqual(["github"]);
  });
});

describe("addZeroSkill$", () => {
  it("should add a skill locally and save to compose", async () => {
    let postedContent: ComposeJobPayload | null = null;

    mockComposeApi({
      agents: {
        zero: {
          framework: "claude-code",
          skills: ["https://github.com/vm0-ai/vm0-skills/tree/main/slack"],
        },
      },
    });

    server.use(
      http.post("*/api/compose/jobs", async ({ request }) => {
        postedContent = (await request.json()) as ComposeJobPayload;
        return HttpResponse.json({
          jobId: "job-1",
          status: "completed",
          result: {
            composeId: "new-compose-id",
            composeName: "test-compose",
            versionId: "v2",
            warnings: [],
          },
        });
      }),
      http.put("*/api/orgs/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Add skill locally (deferred save pattern)
    await context.store.set(addZeroSkill$, "github");

    // Local state should include both skills
    const skills = await context.store.get(zeroAddedSkills$);
    expect(skills).toContain("slack");
    expect(skills).toContain("github");

    // Save triggers the compose job
    await context.store.set(saveZeroSkills$);

    expect(postedContent).not.toBeNull();
    const content = getComposeContent(postedContent!);
    const agentKey = Object.keys(content.agents)[0];
    expect(content.agents[agentKey].skills).toContain(
      "https://github.com/vm0-ai/vm0-skills/tree/main/slack",
    );
    expect(content.agents[agentKey].skills).toContain(
      "https://github.com/vm0-ai/vm0-skills/tree/main/github",
    );
  });
});
