import type { Locator } from "@playwright/test";

import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(resolveApiBackendUrl());

async function visibleBox(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Expected visible element geometry");
  }
  return box;
}

test("create a new agent and verify it appears in the list", async ({
  page,
}) => {
  const agentName = `E2E-Agent-${Date.now()}`;

  // Navigate to agents page
  await page.goto(`${appUrl}/agents`);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({
    timeout: 20_000,
  });

  // Visibility is a segment control, so the option is a radio, not a tab.
  await page.getByRole("radio", { name: "Private", exact: true }).click();
  await page
    .getByRole("button", { name: /^(New agent|Create agent)$/ })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Fill name and submit
  await page.getByPlaceholder("e.g. Research Assistant").fill(agentName);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create" })
    .click();

  // Verify agent appears in the list (use exact match to avoid toast collision)
  await expect(page.getByText(agentName, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
});

test("avatar composer keeps a stable dialog and compact option rows", async ({
  page,
}) => {
  await page.goto(`${appUrl}/agents`);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole("radio", { name: "Private", exact: true }).click();
  await page
    .getByRole("button", { name: /^(New agent|Create agent)$/ })
    .first()
    .click();
  const createDialog = page.getByRole("dialog", {
    name: "Create a new agent",
  });
  await createDialog.getByRole("button", { name: "Customize avatar" }).click();

  const composer = page.getByRole("dialog", {
    name: "Give your agent a face",
  });
  const initialBox = await visibleBox(composer);
  const expectStableDialog = async () => {
    const currentBox = await visibleBox(composer);
    expect(Math.abs(currentBox.width - initialBox.width)).toBeLessThanOrEqual(
      1,
    );
    expect(Math.abs(currentBox.height - initialBox.height)).toBeLessThanOrEqual(
      1,
    );
  };

  await expect(composer.getByText("Face", { exact: true })).toBeVisible();
  await expect(composer.getByRole("button", { name: "Oval" })).toBeVisible();
  await expectStableDialog();

  await composer.getByRole("button", { name: "Next step" }).click();
  await expect(composer.getByText("Hair", { exact: true })).toBeVisible();
  const firstRowOption = composer.getByRole("button", { name: "High bun" });
  const secondRowOption = composer.getByRole("button", {
    name: "Triple bun",
  });
  // The staggered entrance animation temporarily transforms the option boxes.
  // Measure the product layout only after the later row has settled.
  await expect(secondRowOption).toBeVisible();
  await secondRowOption.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => {
        return animation.finished;
      }),
    );
  });
  const firstRow = await visibleBox(firstRowOption);
  const secondRow = await visibleBox(secondRowOption);
  const rowGap = secondRow.y - firstRow.y - firstRow.height;
  expect(rowGap).toBeGreaterThanOrEqual(0);
  expect(rowGap).toBeLessThanOrEqual(16);
  await expectStableDialog();

  await composer.getByRole("button", { name: "Next step" }).click();
  await expect(composer.getByText("Mood", { exact: true })).toBeVisible();
  const lastExpression = composer.getByRole("button", {
    name: "Stubble smile",
  });
  await lastExpression.scrollIntoViewIfNeeded();
  await expect(lastExpression).toBeInViewport();
  await expectStableDialog();

  await composer.getByRole("button", { name: "Next step" }).click();
  await expect(composer.getByText("Skin", { exact: true })).toBeVisible();
  await expectStableDialog();

  await composer.getByRole("button", { name: "Next step" }).click();
  await expect(composer.getByText("Color", { exact: true })).toBeVisible();
  await expectStableDialog();
  // The Sweater step only exists behind `avatarNeckSweater`, which is off for
  // the non-staff org this runs against. Covered in settings-tab.test.tsx.
  await composer.getByRole("button", { name: "Cancel" }).click();
});
