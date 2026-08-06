import { screen, waitFor, within } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import {
  AGENT_ID,
  composerElementFrom,
  context,
  mockAgent,
  mockAgentConnectorAuthorizations,
  mockConnectors,
  mockOrgModelRoutes,
} from "./chat-composer-test-helpers.ts";

beforeEach(() => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
});

describe("chat composer responsive controls", () => {
  it("uses the mobile 2+1 connector layout and restores 3+1 on desktop", async () => {
    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    mockConnectors([
      { connectorSlug: "github" },
      { connectorSlug: "slack" },
      { connectorSlug: "asana" },
    ]);
    mockAgentConnectorAuthorizations(["github", "slack", "asana"]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.StructuredPromptInlineTemplates]: false,
      },
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    const workflowButton = within(composer).getByLabelText("Create workflow");
    const connectorsButton = within(composer).getByLabelText("Connectors");

    await waitFor(() => {
      expect(connectorsButton.querySelectorAll("img")).toHaveLength(3);
    });

    const connectorIcons = connectorsButton.firstElementChild;
    if (!(connectorIcons instanceof HTMLElement)) {
      throw new Error("Connector icon group not found");
    }
    const iconWrappers = Array.from(connectorIcons.children);
    const regularConnectorWrappers = iconWrappers.filter((wrapper) => {
      return wrapper.querySelector("img") !== null;
    });
    const computerUseWrappers = iconWrappers.filter((wrapper) => {
      return wrapper.querySelector("img") === null;
    });

    expect(regularConnectorWrappers).toHaveLength(3);
    expect(computerUseWrappers).toHaveLength(1);

    // Declared exception to the no-CSS-class-assertions rule in
    // docs/testing/testing-external-behavior.md and AP-7 of
    // docs/testing/anti-patterns.md. jsdom does not load Tailwind styles, so
    // these responsive visibility rules have no observable computed style.
    expect(workflowButton).toHaveClass("hidden", "sm:inline-flex");
    expect(regularConnectorWrappers[0]).not.toHaveClass("hidden");
    expect(regularConnectorWrappers[1]).not.toHaveClass("hidden");
    expect(regularConnectorWrappers[2]).toHaveClass("hidden", "sm:block");
    expect(computerUseWrappers[0]).not.toHaveClass("hidden");

    const sendButton = within(composer).getByLabelText("Send");
    const composerFooter = sendButton.closest(
      "div.flex.items-center.justify-between",
    );
    if (!(composerFooter instanceof HTMLElement)) {
      throw new Error("Composer footer not found");
    }
    expect(composer).toContainElement(composerFooter);
    expect(composerFooter).toContainElement(connectorsButton);
    expect(composerFooter).toContainElement(sendButton);
  });
});
