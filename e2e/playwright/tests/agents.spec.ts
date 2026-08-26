import type { Locator, Page } from "@playwright/test";
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
const unreadThreadStory = {
  id: "b0000000-0000-4000-a000-000000000704",
  title: "Unread conversation",
  createdAt: "2026-08-25T10:00:00.000Z",
} as const;
type PinnedAgentStoryEntry = (typeof pinnedAgentStory)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function mockPinnedAgentGrid(
  page: Page,
  defaultAgentId: string,
): Promise<(agents: readonly PinnedAgentStoryEntry[]) => void> {
  let pinnedAgents: readonly PinnedAgentStoryEntry[] = pinnedAgentStory;

  await page.route("**/api/feature-switches", async (route) => {
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

  await page.route("**/api/team", async (route) => {
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

  await page.route("**/api/user-preferences", async (route) => {
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

async function mockUnreadThread(
  page: Page,
  defaultAgentId: string,
): Promise<void> {
  await page.route("**/api/chat-threads/snapshot", async (route) => {
    await route.fulfill({
      json: {
        chatThreads: [
          {
            id: unreadThreadStory.id,
            agentId: defaultAgentId,
            title: unreadThreadStory.title,
            sortAt: unreadThreadStory.createdAt,
            createdAt: unreadThreadStory.createdAt,
            updatedAt: unreadThreadStory.createdAt,
            pinnedAt: null,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
          },
        ],
        latestEventId: null,
        latestSeqId: null,
      },
    });
  });
  await page.route(
    (url) => url.pathname === "/api/chat-threads/events",
    async (route) => {
      await route.fulfill({ json: { events: [], hasMore: false } });
    },
  );
  await page.route("**/api/indicators", async (route) => {
    await route.fulfill({
      json: {
        agents: { [defaultAgentId]: "unread" },
        threads: { [unreadThreadStory.id]: "unread" },
      },
    });
  });
  await page.route(
    (url) => url.pathname === "/api/chat-thread-unreads",
    async (route) => {
      await route.fulfill({
        json: {
          unreads: [
            {
              threadId: unreadThreadStory.id,
              unreadAt: unreadThreadStory.createdAt,
            },
          ],
        },
      });
    },
  );
}

async function visibleIndicatorStyle(locator: Locator): Promise<{
  readonly backgroundColor: string;
  readonly borderRadius: string;
  readonly boxShadow: string;
  readonly height: string;
  readonly width: string;
}> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      height: style.height,
      width: style.width,
    };
  });
}

async function computedIconStyle(control: Locator): Promise<{
  readonly height: string;
  readonly opacity: string;
  readonly width: string;
}> {
  const icon = control.locator("svg").first();
  await expect(icon).toBeAttached();
  return icon.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: style.height,
      opacity: style.opacity,
      width: style.width,
    };
  });
}

test("navigate to agents page and verify heading", async ({ page }) => {
  await page.goto(`${appUrl}/agents`);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({
    timeout: 20_000,
  });
});

test("onboarding workflow preview uses the shared dialog radius", async ({
  page,
}) => {
  await page.route("**/api/onboarding/status", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      throw new Error("Onboarding status returned an unexpected response");
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        needsOnboarding: true,
        onboardingComplete: false,
      },
    });
  });
  await page.route("**/api/connector-catalog/status", async (route) => {
    await route.fulfill({ json: { connectors: [] } });
  });

  const workflowUrl = new URL("/onboarding/workflow-run", appUrl);
  workflowUrl.searchParams.set("choice", "workflow");
  workflowUrl.searchParams.set("category", "marketing");
  workflowUrl.searchParams.set("workflow", "track-keyword-ranks-ahrefs");
  await page.goto(workflowUrl.toString());

  await expect(
    page.getByRole("heading", { name: "Review your workflow draft" }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Preview workflow details" }).click();

  const preview = page.getByRole("dialog", {
    name: "Audit a website's technical SEO",
  });
  await expect(preview).toBeVisible();
  expect(
    await preview.evaluate((element) => {
      return getComputedStyle(element).borderRadius;
    }),
  ).toBe("14px");
});

test("three-column rail and unread indicators preserve their visual hierarchy", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    // The dark palette inverts surface luminance, so use light mode to verify
    // the requested darker rail hierarchy without assuming dark-mode ordering.
    localStorage.setItem("theme", "light");
  });
  await page.goto(appUrl);
  await page.waitForURL(/\/agents\/[^/]+\/chat\/?$/, { timeout: 30_000 });
  const defaultAgentId = new URL(page.url()).pathname.match(
    /^\/agents\/([^/]+)\/chat\/?$/,
  )?.[1];
  if (!defaultAgentId) {
    throw new Error("Could not resolve the default agent from the sidebar");
  }

  const setPinnedAgents = await mockPinnedAgentGrid(page, defaultAgentId);
  await mockUnreadThread(page, defaultAgentId);
  await Promise.all([
    ...[
      "/api/feature-switches",
      "/api/onboarding/status",
      "/api/team",
      "/api/user-preferences",
      "/api/chat-threads/snapshot",
      "/api/indicators",
      "/api/chat-thread-unreads",
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
  const chatList = page.getByTestId("chat-list-column");
  const cards = grid.getByTestId("pinned-agent-card");
  const pinAgent = grid.getByRole("button", {
    name: "Pin an agent",
  });
  await expect(cards).toHaveCount(4);
  await expect(pinAgent).toBeVisible();

  const railSurface = await page
    .getByTestId("labeled-nav-rail")
    .evaluate((rail) => {
      const chatList = document.querySelector(
        '[data-testid="chat-list-column"]',
      );
      if (!(chatList instanceof HTMLElement)) {
        throw new Error("Three-column chat list is not rendered");
      }

      const appearance = (element: Element) => {
        const backgroundColor = getComputedStyle(element).backgroundColor;
        const channels = backgroundColor
          .match(/\d+(?:\.\d+)?/gu)
          ?.slice(0, 3)
          .map(Number);
        const [red, green, blue] = channels ?? [];
        if (red === undefined || green === undefined || blue === undefined) {
          throw new Error(`Cannot read background color: ${backgroundColor}`);
        }
        return {
          backgroundColor,
          luminance: 0.2126 * red + 0.7152 * green + 0.0722 * blue,
        };
      };

      return {
        chatList: appearance(chatList),
        rail: appearance(rail),
      };
    });

  expect(railSurface.rail.backgroundColor).not.toBe(
    railSurface.chatList.backgroundColor,
  );
  expect(railSurface.rail.luminance).toBeLessThan(
    railSurface.chatList.luminance,
  );

  const defaultAgentCard = grid.locator(
    `[data-testid="pinned-agent-card"][href="/agents/${defaultAgentId}/chat"]`,
  );
  const agentUnread = defaultAgentCard.getByLabel("Unread");
  const threadRow = chatList
    .locator(`[data-sidebar-chat-thread-id="${unreadThreadStory.id}"]`)
    .locator("..");
  const threadUnread = threadRow.getByLabel("Unread");
  await expect(agentUnread).toBeVisible();
  await expect(threadUnread).toBeVisible();

  const [agentUnreadStyle, threadUnreadStyle] = await Promise.all([
    visibleIndicatorStyle(agentUnread),
    visibleIndicatorStyle(threadUnread),
  ]);
  expect(Number.parseFloat(threadUnreadStyle.width)).toBeGreaterThan(0);
  expect(agentUnreadStyle).toStrictEqual(threadUnreadStyle);

  expect(
    await computedIconStyle(threadRow.getByTestId("chat-thread-menu-trigger")),
  ).toStrictEqual({ height: "17px", opacity: "0.7", width: "17px" });

  for (const control of [
    chatList.getByLabel("Search workspace"),
    chatList.getByLabel("New chat"),
    chatList.getByLabel("Hide chat list"),
    pinAgent,
    chatList.getByLabel("Open chat list menu"),
  ]) {
    expect(await computedIconStyle(control)).toStrictEqual({
      height: "18px",
      opacity: "1",
      width: "18px",
    });
  }

  await page.getByLabel("Search workspace").click();
  const searchDialog = page.getByRole("dialog", {
    name: "Search chats, messages, workflows, and artifacts...",
  });
  await expect(searchDialog).toBeVisible();
  expect(
    await searchDialog.evaluate((element) => {
      const command = element.querySelector("[cmdk-root]");
      if (!(command instanceof HTMLElement)) {
        throw new Error("Search command surface is not rendered");
      }
      return {
        command: getComputedStyle(command).borderRadius,
        dialog: getComputedStyle(element).borderRadius,
      };
    }),
  ).toStrictEqual({ command: "14px", dialog: "14px" });
  await page.keyboard.press("Escape");
  await expect(searchDialog).toBeHidden();

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
        new URL(response.url()).pathname === "/api/user-preferences"
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
