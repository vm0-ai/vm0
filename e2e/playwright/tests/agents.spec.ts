import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_BACKEND_URL!);
const pinnedAgentStory = [
  {
    id: "c0000000-0000-4000-a000-000000000701",
    displayName: "Research Agent",
  },
  {
    id: "c0000000-0000-4000-a000-000000000702",
    displayName: "Support Agent",
  },
  {
    id: "c0000000-0000-4000-a000-000000000703",
    displayName: "Operations Agent",
  },
] as const;
type PinnedAgentStoryEntry = (typeof pinnedAgentStory)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function mockPinnedAgentGrid(
  page: Page,
  defaultAgentId: string,
): Promise<(agents: readonly PinnedAgentStoryEntry[]) => void> {
  let pinnedAgents: readonly PinnedAgentStoryEntry[] = pinnedAgentStory;

  await page.route("**/api/okou/feature-switches", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!isRecord(body) || !isRecord(body.effectiveSwitches)) {
      throw new Error("Feature switches returned an unexpected response");
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        effectiveSwitches: {
          ...body.effectiveSwitches,
          threeColumnNav: true,
        },
      },
    });
  });

  await page.route("**/api/okou/team", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!Array.isArray(body) || !body.every(isRecord)) {
      throw new Error("Team returned an unexpected response");
    }
    const defaultAgent = body.find((agent) => {
      return agent.id === defaultAgentId;
    });
    if (!defaultAgent) {
      throw new Error("Default agent is missing from the team response");
    }
    await route.fulfill({
      response,
      json: [
        defaultAgent,
        ...pinnedAgentStory.map((agent, index) => {
          return {
            ...defaultAgent,
            ...agent,
            headVersionId: `playwright-version-${index + 1}`,
          };
        }),
      ],
    });
  });

  await page.route("**/api/okou/user-preferences", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      throw new Error("User preferences returned an unexpected response");
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        pinnedAgentIds: pinnedAgents.map((agent) => {
          return agent.id;
        }),
      },
    });
  });

  return (agents) => {
    pinnedAgents = agents;
  };
}

test("navigate to agents page and verify heading", async ({ page }) => {
  await page.goto(`${appUrl}/agents`);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({
    timeout: 20_000,
  });
});

test("pinned agents use five equal columns and keep Pin in the first row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(appUrl);
  await page.waitForURL(/\/agents\/[^/]+\/chat\/?$/, { timeout: 30_000 });
  const defaultAgentId = new URL(page.url()).pathname.match(
    /^\/agents\/([^/]+)\/chat\/?$/,
  )?.[1];
  if (!defaultAgentId) {
    throw new Error("Could not resolve the default agent from the sidebar");
  }

  const setPinnedAgents = await mockPinnedAgentGrid(page, defaultAgentId);
  await Promise.all([
    ...[
      "/api/okou/feature-switches",
      "/api/okou/onboarding/status",
      "/api/okou/team",
      "/api/okou/user-preferences",
    ].map((pathname) => {
      return page.waitForResponse((response) => {
        return (
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === pathname
        );
      });
    }),
    page.reload(),
  ]);

  const grid = page.getByTestId("pinned-agents-grid");
  const cards = grid.getByTestId("pinned-agent-card");
  const pinAgent = grid.getByRole("button", {
    name: "Pin an agent",
  });
  await expect(cards).toHaveCount(4);
  await expect(pinAgent).toBeVisible();

  await expect
    .poll(async () => {
      const boxes = await Promise.all([
        cards.nth(0).boundingBox(),
        cards.nth(1).boundingBox(),
        cards.nth(2).boundingBox(),
        cards.nth(3).boundingBox(),
        pinAgent.boundingBox(),
      ]);
      if (boxes.some((box) => box === null)) {
        return Number.POSITIVE_INFINITY;
      }
      const tops = boxes.map((box) => box!.y);
      return Math.max(...tops) - Math.min(...tops);
    })
    .toBeLessThan(2);

  await expect
    .poll(async () => {
      const boxes = await Promise.all([
        cards.nth(0).boundingBox(),
        cards.nth(1).boundingBox(),
        cards.nth(2).boundingBox(),
        cards.nth(3).boundingBox(),
        pinAgent.boundingBox(),
      ]);
      if (boxes.some((box) => box === null)) {
        return 0;
      }
      return Math.min(
        boxes[1]!.x - boxes[0]!.x,
        boxes[2]!.x - boxes[1]!.x,
        boxes[3]!.x - boxes[2]!.x,
        boxes[4]!.x - boxes[3]!.x,
      );
    })
    .toBeGreaterThan(1);

  await expect
    .poll(async () => {
      const boxes = await Promise.all([
        cards.nth(0).boundingBox(),
        cards.nth(1).boundingBox(),
        cards.nth(2).boundingBox(),
        cards.nth(3).boundingBox(),
        pinAgent.boundingBox(),
      ]);
      if (boxes.some((box) => box === null)) {
        return Number.POSITIVE_INFINITY;
      }
      const widths = boxes.map((box) => box!.width);
      return Math.max(...widths) - Math.min(...widths);
    })
    .toBeLessThan(2);

  await expect
    .poll(async () => {
      const [gridBox, pinAgentBox] = await Promise.all([
        grid.boundingBox(),
        pinAgent.boundingBox(),
      ]);
      if (!gridBox || !pinAgentBox) {
        return Number.POSITIVE_INFINITY;
      }
      return Math.abs(
        pinAgentBox.x + pinAgentBox.width - (gridBox.x + gridBox.width),
      );
    })
    .toBeLessThan(2);

  await expect
    .poll(async () => {
      return grid.evaluate((element) => {
        return Math.max(0, element.scrollWidth - element.clientWidth);
      });
    })
    .toBe(0);

  setPinnedAgents(pinnedAgentStory.slice(0, 2));
  await Promise.all([
    page.waitForResponse((response) => {
      return (
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/okou/user-preferences"
      );
    }),
    page.reload(),
  ]);

  await expect(cards).toHaveCount(3);
  await expect
    .poll(async () => {
      const boxes = await Promise.all([
        cards.nth(0).boundingBox(),
        cards.nth(1).boundingBox(),
        cards.nth(2).boundingBox(),
        pinAgent.boundingBox(),
      ]);
      if (boxes.some((box) => box === null)) {
        return Number.POSITIVE_INFINITY;
      }
      const columnStep = boxes[1]!.x - boxes[0]!.x;
      return Math.max(
        Math.abs(boxes[3]!.x - boxes[2]!.x - columnStep),
        Math.abs(boxes[3]!.y - boxes[2]!.y),
      );
    })
    .toBeLessThan(2);
});

test("reveal the default agent unread action from the whole row", async ({
  page,
}) => {
  await page.goto(appUrl);
  await page.waitForURL(/\/agents\/[^/]+\/chat\/?$/, { timeout: 30_000 });
  const defaultAgentId = new URL(page.url()).pathname.match(
    /^\/agents\/([^/]+)\/chat\/?$/,
  )?.[1];
  if (!defaultAgentId) {
    throw new Error("Could not resolve the default agent from the sidebar");
  }

  await page.route("**/api/indicators", async (route) => {
    await route.fulfill({
      json: {
        agents: { [defaultAgentId]: "unread" },
        threads: {},
      },
    });
  });
  await page.reload();
  await page.locator("#app-bootstrap-skeleton").waitFor({ state: "detached" });

  const defaultAgentRow = page.getByTestId("pinned-agent-card").filter({
    has: page.locator(`a[href="/agents/${defaultAgentId}/chat"]`),
  });
  const unreadIndicator = defaultAgentRow.getByLabel("Unread");
  const unreadContainer = unreadIndicator.locator("..");
  const menuTrigger = defaultAgentRow.getByLabel("Open agent menu");

  await expect(unreadIndicator).toBeAttached();
  await expect(menuTrigger).toHaveCSS("opacity", "0");
  await expect(unreadContainer).toHaveCSS("opacity", "1");
  const idleBackground = await menuTrigger.evaluate((element) => {
    return getComputedStyle(element).backgroundColor;
  });

  await defaultAgentRow.getByRole("link").hover({
    position: { x: 12, y: 16 },
  });
  await expect(menuTrigger).toHaveCSS("opacity", "1");
  await expect(unreadContainer).toHaveCSS("opacity", "0");

  await menuTrigger.click();
  await page.mouse.move(0, 0);

  await expect
    .poll(async () => {
      return defaultAgentRow.evaluate((element) => element.matches(":hover"));
    })
    .toBe(false);
  await expect(menuTrigger).toHaveCSS("opacity", "1");
  await expect(unreadContainer).toHaveCSS("opacity", "0");
  const activeBackground = await menuTrigger.evaluate((element) => {
    return getComputedStyle(element).backgroundColor;
  });
  expect(activeBackground).not.toBe(idleBackground);
  await expect(page.getByRole("menuitem")).toHaveCount(1);
  await expect(page.getByRole("menuitem")).toHaveText("Mark all read");
});
