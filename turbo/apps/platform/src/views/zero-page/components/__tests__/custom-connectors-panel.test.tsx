import { describe, expect, it, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { testContext } from "../../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../../__tests__/page-helper.ts";
import {
  setMockCustomConnectors,
  resetMockCustomConnectors,
} from "../../../../mocks/handlers/api-custom-connectors.ts";
import {
  setConnectorsPageTab$,
  openCustomConnectorCreateDialog$,
  openCustomConnectorConnectDialog$,
  openCustomConnectorRenameDialog$,
  openCustomConnectorDeleteDialog$,
  setCustomConnectorRenameInput$,
} from "../../../../signals/zero-page/settings/custom-connectors.ts";
import { FeatureSwitchKey, type CustomConnectorResponse } from "@vm0/core";

const context = testContext();
const user = userEvent.setup();

const CC_1 = "00000001-0000-4000-a000-000000000001";

function makeConnector(
  overrides: Partial<CustomConnectorResponse> & { id: string },
): CustomConnectorResponse {
  return {
    slug: "acme-api",
    displayName: "Acme API",
    prefixes: ["https://api.acme.com/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
    hasSecret: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockCustomConnectors(connectors: CustomConnectorResponse[] = []) {
  setMockCustomConnectors(connectors);
}

async function openCustomTab() {
  detachedSetupPage({
    context,
    path: "/connectors",
    featureSwitches: { [FeatureSwitchKey.OrgCustomConnectors]: true },
  });

  await waitFor(() => {
    expect(screen.getByText("Built-in")).toBeInTheDocument();
  });

  context.store.set(setConnectorsPageTab$, "custom");

  await waitFor(() => {
    expect(screen.getByText("Custom connectors")).toBeInTheDocument();
  });
}

describe("customConnectorsPanel", () => {
  beforeEach(() => {
    resetMockCustomConnectors();
  });

  it("shows empty state when no custom connectors exist", async () => {
    mockCustomConnectors();
    await openCustomTab();

    expect(screen.getByText(/No custom connectors yet/)).toBeInTheDocument();
  });

  it("renders connector rows with display name and prefix", async () => {
    mockCustomConnectors([
      makeConnector({
        id: CC_1,
        displayName: "Stripe API",
        prefixes: ["https://api.stripe.com/v1/"],
      }),
    ]);

    await openCustomTab();

    await waitFor(() => {
      expect(screen.getByText("Stripe API")).toBeInTheDocument();
    });
    expect(screen.getByText("https://api.stripe.com/v1/")).toBeInTheDocument();
  });

  it("shows Connect button when connector has no secret", async () => {
    mockCustomConnectors([makeConnector({ id: CC_1, hasSecret: false })]);

    await openCustomTab();

    await waitFor(() => {
      expect(screen.getByText(/^connect$/i)).toBeInTheDocument();
    });
  });

  it("shows Connected label when connector has secret", async () => {
    mockCustomConnectors([
      makeConnector({
        id: CC_1,
        displayName: "Acme",
        hasSecret: true,
      }),
    ]);

    await openCustomTab();

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });
  });

  it("opens connect dialog via signal and submits credential", async () => {
    const connector = makeConnector({
      id: CC_1,
      displayName: "Acme API",
      hasSecret: false,
    });
    mockCustomConnectors([connector]);

    await openCustomTab();

    context.store.set(openCustomConnectorConnectDialog$, connector);

    await waitFor(() => {
      expect(screen.getByText("Connect Acme API")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Credential")).toBeInTheDocument();

    await fill(screen.getByLabelText("Credential"), "sk-test-123");

    const dialog = screen.getByRole("dialog");
    const saveButton = within(dialog)
      .getAllByRole("button")
      .find((el) => {
        return /save/i.test(el.textContent ?? "");
      });
    await user.click(saveButton!);

    await waitFor(() => {
      expect(
        screen.getAllByText("Connected").find((el) => {
          return el.closest(".zero-card") !== null;
        }),
      ).toBeTruthy();
    });
  });

  it("opens create dialog via signal and shows form fields", async () => {
    mockCustomConnectors();

    await openCustomTab();

    context.store.set(openCustomConnectorCreateDialog$);

    await waitFor(() => {
      expect(screen.getByText("New custom connector")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Display name")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Authorization")).toBeInTheDocument();
  });

  it("opens rename dialog via signal with prefilled name", async () => {
    const connector = makeConnector({
      id: CC_1,
      displayName: "Acme API",
      hasSecret: true,
    });
    mockCustomConnectors([connector]);

    await openCustomTab();

    context.store.set(setCustomConnectorRenameInput$, "Acme API");
    context.store.set(openCustomConnectorRenameDialog$, connector);

    await waitFor(() => {
      expect(screen.getByText("Rename custom connector")).toBeInTheDocument();
    });

    const input = screen.getByDisplayValue("Acme API");
    expect(input).toBeInTheDocument();
  });

  it("opens delete confirm dialog via signal", async () => {
    const connector = makeConnector({
      id: CC_1,
      displayName: "Acme API",
      hasSecret: true,
    });
    mockCustomConnectors([connector]);

    await openCustomTab();

    context.store.set(openCustomConnectorDeleteDialog$, connector);

    await waitFor(() => {
      expect(screen.getByText("Delete Acme API?")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/removes the connector and every member/),
    ).toBeInTheDocument();
  });

  it("closes delete dialog on cancel", async () => {
    const connector = makeConnector({
      id: CC_1,
      displayName: "Acme API",
      hasSecret: true,
    });
    mockCustomConnectors([connector]);

    await openCustomTab();

    context.store.set(openCustomConnectorDeleteDialog$, connector);

    await waitFor(() => {
      expect(screen.getByText("Delete Acme API?")).toBeInTheDocument();
    });

    const dialog = screen.getByRole("dialog");
    const cancelButton = within(dialog)
      .getAllByRole("button")
      .find((el) => {
        return /cancel/i.test(el.textContent ?? "");
      });
    await user.click(cancelButton!);

    await waitFor(() => {
      expect(screen.queryByText("Delete Acme API?")).not.toBeInTheDocument();
    });
  });

  it("deletes connector via delete confirm dialog", async () => {
    const connector = makeConnector({
      id: CC_1,
      displayName: "Acme API",
      hasSecret: true,
    });
    mockCustomConnectors([connector]);

    await openCustomTab();

    context.store.set(openCustomConnectorDeleteDialog$, connector);

    await waitFor(() => {
      expect(screen.getByText("Delete Acme API?")).toBeInTheDocument();
    });

    const dialog = screen.getByRole("dialog");
    const deleteButton = within(dialog)
      .getAllByRole("button")
      .find((el) => {
        return /delete/i.test(el.textContent ?? "");
      });
    await user.click(deleteButton!);

    await waitFor(() => {
      expect(screen.queryByText("Delete Acme API?")).not.toBeInTheDocument();
    });
  });
});
