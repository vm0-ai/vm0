import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  zeroAddedSkills$,
  addZeroSkill$,
  removeZeroSkill$,
  zeroUpdateSettings$,
  zeroSettingsSaving$,
} from "../zero-meet.ts";

const context = testContext();

interface ComposeJobPayload {
  content: { agents: Record<string, { skills?: string[] }> };
}

function getComposeContent(payload: Record<string, unknown>) {
  return (payload as unknown as ComposeJobPayload).content;
}

function mockComposeApi(content: {
  agents: Record<string, { framework: string; skills?: string[] }>;
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

function mockComposeJobSuccess(resultComposeId = "new-compose-id") {
  server.use(
    http.post("*/api/compose/jobs", () => {
      return HttpResponse.json({
        jobId: "job-1",
        status: "completed",
        result: {
          composeId: resultComposeId,
          composeName: "test-compose",
          versionId: "v2",
          warnings: [],
        },
      });
    }),
    http.put("*/api/scopes/default-agent", () => {
      return HttpResponse.json({ ok: true });
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
  it("should add a skill and sync to compose", async () => {
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
      http.put("*/api/scopes/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(addZeroSkill$, "github");

    // Verify the compose job was triggered with updated skills
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

  it("should rollback on compose job failure", async () => {
    mockComposeApi({
      agents: {
        zero: {
          framework: "claude-code",
          skills: ["https://github.com/vm0-ai/vm0-skills/tree/main/slack"],
        },
      },
    });

    server.use(
      http.post("*/api/compose/jobs", () => {
        return HttpResponse.json(
          { error: { message: "Build failed" } },
          { status: 500 },
        );
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(addZeroSkill$, "github");

    // Should have rolled back -- github should not be in the list
    const skills = await context.store.get(zeroAddedSkills$);
    expect(skills).not.toContain("github");
    expect(skills).toContain("slack");
  });
});

describe("removeZeroSkill$", () => {
  it("should remove a skill and sync to compose", async () => {
    let postedContent: Record<string, unknown> | null = null;

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
      http.put("*/api/scopes/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(removeZeroSkill$, "slack");

    // Verify compose job was triggered with only github
    expect(postedContent).toBeTruthy();
    const content = getComposeContent(postedContent!);
    const agentKey = Object.keys(content.agents)[0];
    expect(content.agents[agentKey].skills).toContain(
      "https://github.com/vm0-ai/vm0-skills/tree/main/github",
    );
    expect(content.agents[agentKey].skills).not.toContain(
      "https://github.com/vm0-ai/vm0-skills/tree/main/slack",
    );
  });

  it("should rollback on compose job failure", async () => {
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

    server.use(
      http.post("*/api/compose/jobs", () => {
        return HttpResponse.json(
          { error: { message: "Build failed" } },
          { status: 500 },
        );
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(removeZeroSkill$, "slack");

    // Should have rolled back -- slack should still be in the list
    const skills = await context.store.get(zeroAddedSkills$);
    expect(skills).toContain("slack");
    expect(skills).toContain("github");
  });
});

describe("zeroUpdateSettings$", () => {
  it("should rename agent via compose job", async () => {
    let postedContent: Record<string, unknown> | null = null;
    let defaultAgentBody: Record<string, unknown> | null = null;

    mockComposeApi({
      agents: {
        zero: { framework: "claude-code" },
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
      http.put("*/api/scopes/default-agent", async ({ request }) => {
        defaultAgentBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(zeroUpdateSettings$, "MyAgent");

    // Verify compose job was triggered with the renamed agent
    expect(postedContent).toBeTruthy();
    const content = getComposeContent(postedContent!);
    expect(content.agents).toHaveProperty("myagent");
    expect(content.agents).not.toHaveProperty("zero");

    // Verify default agent was updated
    expect(defaultAgentBody).toStrictEqual({
      agentComposeId: "new-compose-id",
    });
  });

  it("should not update when name has not changed", async () => {
    let composeJobCalled = false;

    mockComposeApi({
      agents: {
        zero: { framework: "claude-code" },
      },
    });

    server.use(
      http.post("*/api/compose/jobs", () => {
        composeJobCalled = true;
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
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // "Zero" lowercased === "zero" so no change
    await context.store.set(zeroUpdateSettings$, "Zero");

    expect(composeJobCalled).toBeFalsy();
  });

  it("should set saving state during update", async () => {
    mockComposeApi({
      agents: {
        zero: { framework: "claude-code" },
      },
    });
    mockComposeJobSuccess();

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(zeroUpdateSettings$, "NewAgent");

    // After completion, saving should be false
    expect(context.store.get(zeroSettingsSaving$)).toBeFalsy();
  });

  it("should handle compose job failure gracefully", async () => {
    mockComposeApi({
      agents: {
        zero: { framework: "claude-code" },
      },
    });

    server.use(
      http.post("*/api/compose/jobs", () => {
        return HttpResponse.json(
          { error: { message: "Build failed" } },
          { status: 500 },
        );
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Should not throw -- error is caught and toasted
    await context.store.set(zeroUpdateSettings$, "NewAgent");

    expect(context.store.get(zeroSettingsSaving$)).toBeFalsy();
  });
});
