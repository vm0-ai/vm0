import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "ccstate-react";
import { describe, expect, it, vi } from "vitest";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { forceUpgradeDialogOpen$ } from "../../../signals/force-upgrade.ts";
import { ForceUpgradeDialog } from "../force-upgrade-dialog.tsx";

const context = testContext();

describe("force upgrade dialog", () => {
  it("stays hidden when the client does not need a force upgrade", async () => {
    render(
      <StoreProvider value={context.store}>
        <ForceUpgradeDialog />
      </StoreProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("shows an update dialog and refreshes after confirmation", async () => {
    const reload = vi.fn();
    context.store.set(forceUpgradeDialogOpen$, true);

    render(
      <StoreProvider value={context.store}>
        <ForceUpgradeDialog reload={reload} />
      </StoreProvider>,
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Update required",
    });
    expect(dialog).toHaveTextContent(
      "This version of VM0 is no longer supported.",
    );

    await userEvent.click(screen.getByText("Refresh"));

    expect(reload).toHaveBeenCalledOnce();
  });
});
