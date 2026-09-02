import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

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

function expectBefore(first: HTMLElement, second: HTMLElement): void {
  expect(
    Boolean(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBeTruthy();
}

describe("lab page", () => {
  it("stays accessible when onboarding is required", async () => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
      const switches = { [FeatureSwitchKey.Banking]: true };
      return respond(200, { switches, effectiveSwitches: switches });
    });

    detachedSetupPage({ context, path: "/_/lab" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Lab" })).toBeInTheDocument();
      expect(
        within(featureSwitchGroup("Beta")).getByText(FeatureSwitchKey.Banking),
      ).toBeInTheDocument();
      expect(screen.getByTestId("pinned-agent-card")).toBeInTheDocument();
      expect(pathname()).toBe("/_/lab");
    });
  });

  it("groups every switch by rollout stage without personal controls", async () => {
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
      return respond(200, { switches: {}, effectiveSwitches: {} });
    });

    detachedSetupPage({ context, path: "/_/lab" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Lab" })).toBeInTheDocument();
    });

    const released = within(featureSwitchGroup("Released"));
    const beta = within(featureSwitchGroup("Beta"));
    const alpha = within(featureSwitchGroup("Alpha"));

    expect(
      released.getAllByRole("listitem").length +
        beta.getAllByRole("listitem").length +
        alpha.getAllByRole("listitem").length,
    ).toBe(Object.values(FeatureSwitchKey).length);
    expect(released.getByText(FeatureSwitchKey.Dummy)).toBeInTheDocument();
    expect(released.queryByText(FeatureSwitchKey.Lab)).not.toBeInTheDocument();
    expect(beta.getByText(FeatureSwitchKey.Lab)).toBeInTheDocument();
    expect(
      beta.queryByText(FeatureSwitchKey.IntroVideo),
    ).not.toBeInTheDocument();
    expect(alpha.getByText(FeatureSwitchKey.IntroVideo)).toBeInTheDocument();
    expect(
      alpha.getByText(FeatureSwitchKey.AhrefsConnector),
    ).toBeInTheDocument();
    expect(released.queryByRole("switch")).not.toBeInTheDocument();
    expect(beta.queryByRole("switch")).not.toBeInTheDocument();
    expect(alpha.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText("Reset all")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Maintainer:/u)).not.toBeInTheDocument();
  });

  it("shows feature switches in name order within each rollout stage", async () => {
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
      return respond(200, { switches: {}, effectiveSwitches: {} });
    });

    detachedSetupPage({ context, path: "/_/lab" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Lab" })).toBeInTheDocument();
    });

    expectBefore(
      featureSwitchRow(FeatureSwitchKey.CodexFastMode),
      featureSwitchRow(FeatureSwitchKey.Banking),
    );
  });

  it("shows the Lab rollout groups in Brazilian Portuguese", async () => {
    document.documentElement.lang = "pt-BR";
    context.mocks.data.userPreferences({ locale: "pt-BR" });
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
      return respond(200, { switches: {}, effectiveSwitches: {} });
    });

    detachedSetupPage({ context, path: "/_/lab" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Laboratório" }),
      ).toBeInTheDocument();
      expect(document.title).toBe("Lab | VM0");
    });
    expect(
      screen.getByText("Veja os recursos por estágio de lançamento."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Lançados" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Alfa" })).toBeInTheDocument();
  });
});
