import { screen, waitFor, within } from "@testing-library/react";
import {
  apiKeysByIdContract,
  apiKeysContract,
  type ApiKeyItem,
} from "@vm0/api-contracts/contracts/api-keys";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function dialogByText(text: string): HTMLElement {
  const dialog = screen.getByText(text).closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error(`${text} dialog not found`);
  }
  return dialog;
}

function closestDialog(element: Element, label: string): HTMLElement {
  const dialog = element.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error(`${label} dialog not found`);
  }
  return dialog;
}

function createApiKey(overrides: Partial<ApiKeyItem>): ApiKeyItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "CI deploy key",
    tokenPrefix: "vm0_pat_ci...",
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: "2026-04-01T00:00:00Z",
    lastUsedAt: null,
    ...overrides,
  };
}

function mockApiKeyStory(): void {
  let apiKeys: ApiKeyItem[] = [
    createApiKey({
      id: "11111111-1111-4111-8111-111111111111",
      name: "CI deploy key",
      tokenPrefix: "vm0_pat_ci...",
    }),
  ];

  context.mocks.api(apiKeysContract.list, ({ respond }) => {
    return respond(200, { apiKeys });
  });
  context.mocks.api(apiKeysContract.create, ({ body, respond }) => {
    const created = createApiKey({
      id: "22222222-2222-4222-8222-222222222222",
      name: body.name,
      tokenPrefix: "vm0_pat_preview...",
      createdAt: "2026-02-01T00:00:00Z",
      expiresAt: "2026-05-02T00:00:00Z",
    });
    apiKeys = [...apiKeys, created];
    return respond(201, {
      ...created,
      token: "vm0_pat_preview_full_token",
    });
  });
  context.mocks.api(apiKeysByIdContract.delete, ({ params, respond }) => {
    apiKeys = apiKeys.filter((key) => {
      return key.id !== params.id;
    });
    return respond(204);
  });
}

describe("zero API keys page", () => {
  it("creates, copies, and revokes an API key from the settings page", async () => {
    context.mocks.browser.clipboardWriteText();
    mockApiKeyStory();

    detachedSetupPage({
      context,
      path: "/settings/api-keys",
      featureSwitches: {
        [FeatureSwitchKey.ApiKeys]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("CI deploy key")).toBeInTheDocument();
    });
    expect(screen.getByText("vm0_pat_ci...")).toBeInTheDocument();

    click(buttonByText("Create API key"));

    const createDialog = await screen.findByRole("dialog");
    expect(
      within(createDialog).getByText("Create API key"),
    ).toBeInTheDocument();
    expect(buttonByText("Create", createDialog)).toBeDisabled();

    await fill(within(createDialog).getByLabelText("Name"), "Preview deploy");
    click(buttonByText("Create", createDialog));

    await waitFor(() => {
      expect(screen.getByText("API key created")).toBeInTheDocument();
    });
    const revealDialog = screen.getByRole("dialog");
    expect(
      within(revealDialog).getByText("Preview deploy"),
    ).toBeInTheDocument();
    expect(
      within(revealDialog).getByText("vm0_pat_preview_full_token"),
    ).toBeInTheDocument();

    within(revealDialog).getByLabelText("Copy to clipboard").click();

    await waitFor(() => {
      expect(within(revealDialog).getByLabelText("Copied")).toBeInTheDocument();
    });

    click(buttonByText("Done", revealDialog));

    await waitFor(() => {
      expect(screen.queryByText("API key created")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Preview deploy")).toBeInTheDocument();
    expect(screen.getByText("vm0_pat_preview...")).toBeInTheDocument();

    click(screen.getByLabelText("Revoke Preview deploy"));

    const revokeDialog = await screen.findByRole("dialog");
    expect(
      within(revokeDialog).getByText("Revoke Preview deploy?"),
    ).toBeInTheDocument();

    click(buttonByText("Revoke", revokeDialog));

    await waitFor(() => {
      expect(screen.queryByText("Preview deploy")).not.toBeInTheDocument();
    });
    expect(screen.getByText("CI deploy key")).toBeInTheDocument();
  });

  it("creates and revokes an API key from the settings dialog", async () => {
    context.mocks.browser.clipboardWriteText();
    mockApiKeyStory();

    detachedSetupPage({
      context,
      path: "/?settings=api-keys",
      featureSwitches: {
        [FeatureSwitchKey.ApiKeys]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(
        screen.getByText("Create and manage API keys for programmatic access."),
      ).toBeInTheDocument();
      expect(screen.getByText("CI deploy key")).toBeInTheDocument();
    });

    click(buttonByText("Create API key"));

    const nameInput = await screen.findByLabelText("Name");
    const createDialog = closestDialog(nameInput, "Create API key");
    await fill(nameInput, "Preview deploy");
    click(buttonByText("Create", createDialog));

    await waitFor(() => {
      expect(screen.getByText("API key created")).toBeInTheDocument();
    });
    const revealDialog = dialogByText("vm0_pat_preview_full_token");
    expect(
      within(revealDialog).getByText("vm0_pat_preview_full_token"),
    ).toBeInTheDocument();
    click(buttonByText("Done", revealDialog));

    await waitFor(() => {
      expect(screen.getByText("Preview deploy")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Revoke Preview deploy"));

    await waitFor(() => {
      expect(screen.getByText("Revoke Preview deploy?")).toBeInTheDocument();
    });
    const revokeDialog = dialogByText("Revoke Preview deploy?");
    click(buttonByText("Revoke", revokeDialog));

    await waitFor(() => {
      expect(screen.queryByText("Preview deploy")).not.toBeInTheDocument();
    });
    expect(screen.getByText("CI deploy key")).toBeInTheDocument();
  });
});
