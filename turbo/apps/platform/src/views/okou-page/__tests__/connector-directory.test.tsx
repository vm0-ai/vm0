import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  builtinConnector,
  httpConnector,
  ACME_CONNECTOR_ID,
  installComposerConnectorFixture,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  context,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

const GITHUB_SLUG = "github" as ConnectorSlug;
const GMAIL_SLUG = "gmail" as ConnectorSlug;
const NOTION_SLUG = "notion" as ConnectorSlug;

function directoryCatalog() {
  // Discovery ranks what it returns, so a fixture without ranks would describe
  // a response the API does not produce.
  return [
    builtinConnector({
      slug: GITHUB_SLUG,
      label: "GitHub",
      connected: true,
      popularityRank: 0,
    }),
    builtinConnector({
      slug: GMAIL_SLUG,
      label: "Gmail",
      connected: false,
      tags: ["email", "inbox"],
      hasPermissions: true,
      popularityRank: 1,
    }),
    builtinConnector({
      slug: NOTION_SLUG,
      label: "Notion",
      connected: false,
      popularityRank: 2,
    }),
  ];
}

function dialogButton(dialog: HTMLElement, name: string): HTMLElement {
  const match = queryAllByRoleFast("button", dialog).find((element) => {
    return (
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name
    );
  });
  if (!match) {
    throw new Error(`Expected a button named "${name}" in the dialog`);
  }
  return match;
}

async function openDirectory(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  await expect(screen.findByTestId("start-cards")).resolves.toBeVisible();
  await user.click(await findFastControl("button", "Connectors"));
  await user.click(await findFastControl("button", "Add connectors"));
  const dialog = await screen.findByRole("dialog", { name: "Connectors" });
  return dialog;
}

test("Offer the catalog for adding, and find a connected connector by name", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  // The composer's connector popover already lists what is connected, so the
  // directory opens on what can be added and does not repeat GitHub.
  const dialog = await openDirectory(user);
  await waitFor(() => {
    expect(within(dialog).getByText("Notion")).toBeVisible();
  });
  expect(within(dialog).queryByText("GitHub")).not.toBeInTheDocument();

  // Searching for it must still answer, or the search reads as "we do not have
  // GitHub" for a connector the user already connected.
  await fill(
    within(dialog).getByPlaceholderText("Find connectors..."),
    "github",
  );
  await waitFor(() => {
    expect(within(dialog).getByText("GitHub")).toBeVisible();
  });
  expect(
    within(dialog).getByRole("heading", { name: "Connected" }),
  ).toBeVisible();
});

test("Find a connector by a tag that is not in its name", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await fill(
    within(dialog).getByPlaceholderText("Find connectors..."),
    "email",
  );

  await waitFor(() => {
    expect(within(dialog).getByText("Gmail")).toBeVisible();
  });
  expect(within(dialog).queryByText("Notion")).not.toBeInTheDocument();
});

test("Open connector detail and step back to the list", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: directoryCatalog(),
    customConnectors: [
      httpConnector({
        id: ACME_CONNECTOR_ID,
        slug: "acme-search",
        displayName: "Acme Search",
        connected: false,
      }),
    ],
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await fill(
    within(dialog).getByPlaceholderText("Find connectors..."),
    "github",
  );
  await waitFor(() => {
    expect(within(dialog).getByText("GitHub")).toBeVisible();
  });
  await user.click(dialogButton(dialog, "Open GitHub details"));

  await waitFor(() => {
    expect(
      within(dialog).getByRole("heading", { name: "GitHub" }),
    ).toBeVisible();
  });
  expect(within(dialog).getByText("Connection")).toBeVisible();

  await user.click(dialogButton(dialog, "Back"));
  await waitFor(() => {
    expect(
      within(dialog).getByRole("heading", { name: "Connected" }),
    ).toBeVisible();
  });
});

test("Keep the existing dialog when the directory switch is off", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  await expect(screen.findByTestId("start-cards")).resolves.toBeVisible();
  await user.click(await findFastControl("button", "Connectors"));
  await user.click(await findFastControl("button", "Add connectors"));

  await expect(
    screen.findByRole("dialog", { name: /Available connectors/u }),
  ).resolves.toBeInTheDocument();
});

test("Keep the category chips the same width when the selection moves", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await waitFor(() => {
    expect(within(dialog).getByText("Notion")).toBeVisible();
  });

  // A chip that changes font weight on selection changes its own width, which
  // shifts every chip after it. Every chip has to carry the same weight.
  const chips = Array.from(
    dialog.querySelectorAll<HTMLElement>("[data-connector-category-chip]"),
  );
  expect(chips.length).toBeGreaterThan(1);
  const weights = new Set(
    chips.map((element) => {
      return (
        element.className.split(/\s+/u).find((token) => {
          return token.startsWith("font-");
        }) ?? "none"
      );
    }),
  );
  expect(weights.size).toBe(1);
  expect(weights).not.toContain("none");
});

function rankedCatalog() {
  // Four ranked connectors earn "mail" a shelf; "voice" has one, so it stays a
  // counted chip rather than opening on the alphabet.
  return [
    ...[
      "Gmail",
      "Outlook Mail",
      "Slack",
      "Microsoft Teams Bot",
      "Discord",
      "Telegram",
      "Lark",
      "Zendesk",
      "Intercom",
      "Mailchimp",
    ].map((label, index) => {
      return builtinConnector({
        slug: `mail-${index}` as ConnectorSlug,
        label,
        connected: false,
        category: "mail",
        popularityRank: index,
      });
    }),
    builtinConnector({
      slug: "voice-0" as ConnectorSlug,
      label: "ElevenLabs",
      connected: false,
      category: "voice",
      popularityRank: 40,
    }),
    builtinConnector({
      slug: "voice-1" as ConnectorSlug,
      label: "3Scribe",
      connected: false,
      category: "voice",
    }),
  ];
}

test("Close a shelf with the products behind it, and open that category", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: rankedCatalog(),
    categoryConnectorCounts: { mail: 327, voice: 50 },
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await waitFor(() => {
    expect(within(dialog).getByTestId("connector-shelf-mail")).toBeVisible();
  });

  // A count alone says nothing to someone who does not know the product names,
  // so the closing cell has to name what it stands for.
  const tail = dialogButton(dialog, "See Telegram, Lark and 323 more");
  expect(tail).toBeVisible();

  // A category with one ranked connector cannot fill a shelf and is offered as
  // a chip instead.
  expect(within(dialog).queryByTestId("connector-shelf-voice")).toBeNull();
  expect(within(dialog).getByText("More categories")).toBeVisible();

  await user.click(tail);
  await waitFor(() => {
    expect(within(dialog).queryByTestId("connector-shelf-mail")).toBeNull();
  });
  expect(within(dialog).getByText("Zendesk")).toBeVisible();
});

test("Show a connector on one shelf only", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: rankedCatalog(),
    categoryConnectorCounts: { mail: 327, voice: 50 },
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await waitFor(() => {
    expect(within(dialog).getByTestId("connector-shelf-head")).toBeVisible();
  });

  // Gmail leads the head shelf, so its own category has to start below it
  // instead of repeating the same card two sections apart.
  expect(within(dialog).getAllByText("Gmail")).toHaveLength(1);
});

test("List the catalog when it is too small for any category to fill a shelf", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await waitFor(() => {
    expect(within(dialog).getByText("Notion")).toBeVisible();
  });

  // Shelves need something to shelve. With two unconnected connectors no
  // category earns one, and the reader must still get the catalog rather than
  // an empty sheet.
  expect(dialog.querySelector("[data-testid^='connector-shelf-']")).toBeNull();
  expect(within(dialog).getByText("Gmail")).toBeVisible();
});
