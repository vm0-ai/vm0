import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function featureSwitchControl(feature: FeatureSwitchKey): HTMLElement {
  const label = screen.getByText(feature).closest("label");
  if (!(label instanceof HTMLElement)) {
    throw new Error(`${feature} feature row not found`);
  }
  return within(label).getByRole("switch");
}

function featureSwitchRow(feature: FeatureSwitchKey): HTMLElement {
  const label = screen.getByText(feature).closest("label");
  if (!(label instanceof HTMLElement)) {
    throw new Error(`${feature} feature row not found`);
  }
  return label;
}

function expectBefore(first: HTMLElement, second: HTMLElement): void {
  expect(
    Boolean(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBeTruthy();
}

function maintainerFilterButton(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim().toLowerCase().startsWith(label);
  });
  if (!button) {
    throw new Error(`${label} maintainer filter not found`);
  }
  return button;
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
      expect(featureSwitchControl(FeatureSwitchKey.Banking)).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(screen.getByTestId("pinned-agent-card")).toBeInTheDocument();
      expect(pathname()).toBe("/_/lab");
    });
  });

  it("lets users toggle and reset feature switches", async () => {
    let switches: Record<string, boolean> = {
      [FeatureSwitchKey.Lab]: true,
      [FeatureSwitchKey.TestOauthConnector]: false,
    };
    let updateBody: Record<string, boolean> | undefined;
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
      return respond(200, { switches, effectiveSwitches: switches });
    });
    context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
      updateBody = body.switches;
      switches = { ...switches, ...body.switches };
      return respond(200, {
        switches: body.switches,
        effectiveSwitches: switches,
      });
    });
    context.mocks.api(featureSwitchesContract.delete, ({ respond }) => {
      switches = {};
      return respond(200, { deleted: true });
    });

    detachedSetupPage({ context, path: "/_/lab" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Lab" })).toBeInTheDocument();
      expect(screen.getByText("Other")).toBeInTheDocument();
      expect(screen.getAllByText("Connectors").length).toBeGreaterThan(0);
      expect(
        screen.getAllByText("Maintainer: liangyou@vm0.ai").length,
      ).toBeGreaterThan(0);
    });

    const testOauthSwitch = featureSwitchControl(
      FeatureSwitchKey.TestOauthConnector,
    );
    expect(testOauthSwitch).toHaveAttribute("aria-checked", "false");

    click(testOauthSwitch);

    await waitFor(() => {
      expect(
        featureSwitchControl(FeatureSwitchKey.TestOauthConnector),
      ).toHaveAttribute("aria-checked", "true");
      expect(updateBody).toStrictEqual({
        [FeatureSwitchKey.TestOauthConnector]: true,
        testOauthConnector: true,
      });
    });

    click(screen.getByText("Reset all"));

    await waitFor(() => {
      expect(
        featureSwitchControl(FeatureSwitchKey.TestOauthConnector),
      ).toHaveAttribute("aria-checked", "false");
    });
  });

  it("writes only the canonical Notion automation switch", async () => {
    let switches: Record<string, boolean> = {
      [FeatureSwitchKey.Lab]: true,
      [FeatureSwitchKey.NotionWorkflowAutomations]: false,
    };
    let updateBody: Record<string, boolean> | undefined;
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
      return respond(200, { switches, effectiveSwitches: switches });
    });
    context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
      updateBody = body.switches;
      switches = { ...switches, ...body.switches };
      return respond(200, {
        switches,
        effectiveSwitches: switches,
      });
    });

    detachedSetupPage({ context, path: "/_/lab" });

    await waitFor(() => {
      expect(
        featureSwitchControl(FeatureSwitchKey.NotionWorkflowAutomations),
      ).toHaveAttribute("aria-checked", "false");
    });
    click(featureSwitchControl(FeatureSwitchKey.NotionWorkflowAutomations));

    await waitFor(() => {
      expect(updateBody).toStrictEqual({
        [FeatureSwitchKey.NotionWorkflowAutomations]: true,
      });
    });
  });

  it("shows feature switches in name order without sort controls", async () => {
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

    expect(
      screen.queryByRole("combobox", { name: "Sort features" }),
    ).not.toBeInTheDocument();
  });

  it("filters feature switches by maintainer", async () => {
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
      return respond(200, { switches: {}, effectiveSwitches: {} });
    });

    detachedSetupPage({ context, path: "/_/lab" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Lab" })).toBeInTheDocument();
    });

    click(maintainerFilterButton("lancy"));

    await waitFor(() => {
      expect(
        screen.getByText(FeatureSwitchKey.NotionWorkflowAutomations),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(FeatureSwitchKey.AhrefsConnector),
      ).not.toBeInTheDocument();
    });

    click(maintainerFilterButton("all"));

    await waitFor(() => {
      expect(
        screen.getByText(FeatureSwitchKey.AhrefsConnector),
      ).toBeInTheDocument();
    });
  });

  it("shows the Lab controls in Brazilian Portuguese", async () => {
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
      screen.getByText("Ative ou desative recursos experimentais."),
    ).toBeInTheDocument();
    expect(screen.getByText("Redefinir tudo")).toBeInTheDocument();
    expect(screen.getByText("Outros")).toBeInTheDocument();
    expect(screen.getAllByText("Conectores").length).toBeGreaterThan(0);
  });
});
