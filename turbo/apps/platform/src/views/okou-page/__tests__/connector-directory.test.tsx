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
  return [
    builtinConnector({ slug: GITHUB_SLUG, label: "GitHub", connected: true }),
    builtinConnector({
      slug: GMAIL_SLUG,
      label: "Gmail",
      connected: false,
      tags: ["email", "inbox"],
      hasPermissions: true,
    }),
    builtinConnector({
      slug: NOTION_SLUG,
      label: "Notion",
      connected: false,
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

test("Separate connected connectors from the catalog", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  expect(
    within(dialog).getByRole("heading", { name: "Connected" }),
  ).toBeVisible();
  expect(within(dialog).getByText("GitHub")).toBeVisible();
  // Discovery lives behind its own tab, so the catalog never mixes into the
  // list of what is already connected.
  expect(within(dialog).queryByText("Notion")).not.toBeInTheDocument();

  await user.click(within(dialog).getByRole("radio", { name: "Discover" }));
  await waitFor(() => {
    expect(within(dialog).getByText("Notion")).toBeVisible();
  });
  expect(within(dialog).queryByText("GitHub")).not.toBeInTheDocument();
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
  await user.click(within(dialog).getByRole("radio", { name: "Discover" }));
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
  await user.click(within(dialog).getByRole("radio", { name: "Discover" }));
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
