import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const PINNED_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function featureSwitchRow(feature: FeatureSwitchKey): HTMLElement {
  const row = screen.getByText(feature).closest("li");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`${feature} feature row not found`);
  }
  return row;
}

function featureSwitchGroup(name: string): HTMLElement {
  const section = screen.getByRole("heading", { name }).closest("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error(`${name} feature group not found`);
  }
  return section;
}

test("Lab remains available while onboarding is required", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  context.mocks.data.agents([
    {
      agentId: PINNED_AGENT_ID,
      displayName: "Pinned Agent",
      visibility: "private",
    },
  ]);

  await setupPage({
    context,
    path: "/_/lab",
    featureSwitches: {
      [FeatureSwitchKey.Banking]: true,
      [FeatureSwitchKey.Lab]: true,
    },
  });

  await screen.findByRole("heading", { name: "Lab" });
  expect(
    within(featureSwitchGroup("Beta")).getByText(FeatureSwitchKey.Banking),
  ).toBeInTheDocument();
  expect((await screen.findAllByText("Pinned Agent")).length).toBeGreaterThan(
    0,
  );
});

test("Lab groups every feature by rollout stage without personal controls", async () => {
  await setupPage({
    context,
    path: "/_/lab",
    featureSwitches: { [FeatureSwitchKey.Lab]: true },
  });

  await screen.findByRole("heading", { name: "Lab" });

  const released = featureSwitchGroup("Released");
  const beta = featureSwitchGroup("Beta");
  const alpha = featureSwitchGroup("Alpha");
  const featureRows = [released, beta, alpha].flatMap((group) => {
    return Array.from(group.querySelectorAll("li"));
  });

  expect(featureRows).toHaveLength(Object.values(FeatureSwitchKey).length);
  expect(
    new Set(
      featureRows.map((row) => {
        return row.textContent?.trim();
      }),
    ).size,
  ).toBe(featureRows.length);
  expect(within(released).getByText(FeatureSwitchKey.Dummy)).toBeVisible();
  expect(within(beta).getByText(FeatureSwitchKey.Lab)).toBeVisible();
  expect(within(alpha).getByText(FeatureSwitchKey.IntroVideo)).toBeVisible();
  expect(document.querySelectorAll('[role="switch"]')).toHaveLength(0);
  expect(screen.queryByText("Reset all")).not.toBeInTheDocument();
  expect(screen.queryByText(/^Maintainer:/u)).not.toBeInTheDocument();
});

test("Lab orders features by name within each rollout stage", async () => {
  await setupPage({
    context,
    path: "/_/lab",
    featureSwitches: { [FeatureSwitchKey.Lab]: true },
  });

  await screen.findByRole("heading", { name: "Lab" });

  const codexFastMode = featureSwitchRow(FeatureSwitchKey.CodexFastMode);
  const banking = featureSwitchRow(FeatureSwitchKey.Banking);
  expect(
    codexFastMode.compareDocumentPosition(banking) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("Lab localizes rollout stages in Brazilian Portuguese", async () => {
  await setupPage({
    context,
    path: "/_/lab",
    locale: "pt-BR",
    featureSwitches: { [FeatureSwitchKey.Lab]: true },
  });

  await screen.findByRole("heading", { name: "Laboratório" });

  expect(document.title).toBe("Lab | VM0");
  expect(
    screen.getByText("Veja os recursos por estágio de lançamento."),
  ).toBeInTheDocument();
  expect(featureSwitchGroup("Lançados")).toBeVisible();
  expect(featureSwitchGroup("Beta")).toBeVisible();
  expect(featureSwitchGroup("Alfa")).toBeVisible();
});
