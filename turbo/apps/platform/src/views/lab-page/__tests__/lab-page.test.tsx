import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
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

function featureSwitchControl(feature: FeatureSwitchKey): HTMLElement {
  return within(featureSwitchRow(feature)).getByRole("switch");
}

function featureSwitchGroup(name: string): HTMLElement {
  const section = screen.getByRole("heading", { name }).closest("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error(`${name} feature group not found`);
  }
  return section;
}

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
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
      expect(featureSwitchControl(FeatureSwitchKey.Banking)).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(screen.getByTestId("pinned-agent-card")).toBeInTheDocument();
      expect(pathname()).toBe("/_/lab");
    });
  });

  it("groups every switch by rollout stage with personal controls", async () => {
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
    const internal = within(featureSwitchGroup("Internal"));

    expect(
      released.getAllByRole("listitem").length +
        beta.getAllByRole("listitem").length +
        alpha.getAllByRole("listitem").length +
        internal.getAllByRole("listitem").length,
    ).toBe(Object.values(FeatureSwitchKey).length);
    for (const key of Object.values(FeatureSwitchKey).filter((feature) => {
      return feature.startsWith("_");
    })) {
      expect(internal.getByText(key)).toBeInTheDocument();
      expect(released.queryByText(key)).not.toBeInTheDocument();
      expect(beta.queryByText(key)).not.toBeInTheDocument();
      expect(alpha.queryByText(key)).not.toBeInTheDocument();
    }
    expect(beta.getByText(FeatureSwitchKey.IntroVideo)).toBeInTheDocument();
    expect(
      beta.getByText(FeatureSwitchKey.DesktopScreenRecording),
    ).toBeInTheDocument();
    expect(
      alpha.getByText(FeatureSwitchKey.AhrefsConnector),
    ).toBeInTheDocument();
    expect(released.getAllByRole("switch")).toHaveLength(
      released.getAllByRole("listitem").length,
    );
    expect(beta.getAllByRole("switch")).toHaveLength(
      beta.getAllByRole("listitem").length,
    );
    expect(alpha.getAllByRole("switch")).toHaveLength(
      alpha.getAllByRole("listitem").length,
    );
    expect(internal.getAllByRole("switch")).toHaveLength(
      internal.getAllByRole("listitem").length,
    );
    expect(buttonByText("Reset all")).toBeInTheDocument();
    expect(screen.queryByText(/^Maintainer:/u)).not.toBeInTheDocument();
  });

  it("lets users toggle and reset feature switches", async () => {
    const user = userEvent.setup();
    let switches: Partial<Record<FeatureSwitchKey, boolean>> = {
      [FeatureSwitchKey.Lab]: true,
      [FeatureSwitchKey.TestOauthConnector]: false,
    };
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
      return respond(200, { switches, effectiveSwitches: switches });
    });
    context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
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
      expect(
        featureSwitchControl(FeatureSwitchKey.TestOauthConnector),
      ).toHaveAttribute("aria-checked", "false");
    });

    click(featureSwitchControl(FeatureSwitchKey.TestOauthConnector));

    await waitFor(() => {
      expect(
        featureSwitchControl(FeatureSwitchKey.TestOauthConnector),
      ).toHaveAttribute("aria-checked", "true");
    });

    const reset = buttonByText("Reset all");
    expectBefore(reset, screen.getByRole("heading", { name: "Released" }));
    reset.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(
        featureSwitchControl(FeatureSwitchKey.TestOauthConnector),
      ).toHaveAttribute("aria-checked", "false");
    });
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
      featureSwitchRow(FeatureSwitchKey.Lab),
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
    expect(
      screen.getByRole("heading", { name: "Internos" }),
    ).toBeInTheDocument();
    expect(buttonByText("Redefinir tudo")).toBeInTheDocument();
  });
});
