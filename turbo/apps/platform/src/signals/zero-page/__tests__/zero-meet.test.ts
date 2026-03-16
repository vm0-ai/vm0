import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  zeroAddedSkills$,
  addZeroSkill$,
  saveZeroSkills$,
} from "../zero-meet.ts";

const context = testContext();

interface ComposeJobPayload {
  content: { agents: Record<string, { skills?: string[] }> };
}

function getComposeContent(payload: Record<string, unknown>) {
  return (payload as unknown as ComposeJobPayload).content;
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
});

describe("addZeroSkill$", () => {
  it("should add a skill locally and save to compose", async () => {
    let postedContent: Record<string, unknown> | null = null;

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
        postedContent = (await request.json()) as Record<string, unknown>;
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

    expect(postedContent).toBeTruthy();
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
