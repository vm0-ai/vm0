import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  zeroAddedConnectors$,
  addZeroConnector$,
  saveZeroConnectors$,
} from "../zero-connectors.ts";
import { setZeroChatAgent$ } from "../zero-nav.ts";
import { SEED_SKILLS } from "../../../data/the-seed.ts";

const context = testContext();

function mockComposeApi(content: {
  agents: Record<
    string,
    {
      framework: string;
      skills?: string[];
    }
  >;
}) {
  server.use(
    http.get("*/api/zero/composes/mock-compose-id", () => {
      return HttpResponse.json({
        id: "mock-compose-id",
        name: "test-compose",
        headVersionId: "v1",
        content: { version: "1", ...content },
      });
    }),
  );
}

describe("zeroAddedConnectors$", () => {
  it("should seed connectors from compose content", async () => {
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

    const connectors = await context.store.get(zeroAddedConnectors$);
    // SEED_SKILLS are always included, plus compose-specific connectors
    expect(connectors).toStrictEqual([...SEED_SKILLS, "slack", "github"]);
  });

  it("should return seed connectors when compose has no skills", async () => {
    mockComposeApi({
      agents: { zero: { framework: "claude-code" } },
    });

    await setupPage({ context, path: "/", withoutRender: true });

    const connectors = await context.store.get(zeroAddedConnectors$);
    expect(connectors).toStrictEqual([...SEED_SKILLS]);
  });

  it("should seed connectors from sub-agent compose when chat agent is set", async () => {
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
      http.get(`*/api/zero/composes/${subAgentComposeId}`, () => {
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

    const connectors = await context.store.get(zeroAddedConnectors$);
    // SEED_SKILLS are always included, plus sub-agent compose connectors
    expect(connectors).toStrictEqual([...SEED_SKILLS, "github"]);
  });
});

describe("addZeroConnector$", () => {
  it("should add a connector locally and save via zero agents api", async () => {
    let capturedBody: { connectors: string[] } | null = null;

    mockComposeApi({
      agents: {
        zero: {
          framework: "claude-code",
          skills: ["https://github.com/vm0-ai/vm0-skills/tree/main/slack"],
        },
      },
    });

    server.use(
      http.put("*/api/zero/agents/test-compose", async ({ request }) => {
        capturedBody = (await request.json()) as { connectors: string[] };
        return HttpResponse.json({
          name: "test-compose",
          agentComposeId: "mock-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: capturedBody.connectors,
        });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Add connector locally (deferred save pattern)
    await context.store.set(addZeroConnector$, "github");

    // Local state should include both connectors
    const connectors = await context.store.get(zeroAddedConnectors$);
    expect(connectors).toContain("slack");
    expect(connectors).toContain("github");

    // Save triggers the zero agents API
    await context.store.set(saveZeroConnectors$);

    expect(capturedBody).not.toBeNull();
    // Connectors are sent as short names
    expect(capturedBody!.connectors).toContain("slack");
    expect(capturedBody!.connectors).toContain("github");
  });
});
