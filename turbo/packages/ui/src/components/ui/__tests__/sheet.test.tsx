import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "../dialog";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "../sheet";

describe("Sheet", () => {
  it("closes the nested sheet and returns focus to its parent dialog", async () => {
    const user = userEvent.setup();
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Connections</DialogTitle>
          <Sheet>
            <SheetTrigger>Open permissions</SheetTrigger>
            <SheetContent>
              <SheetTitle>Permissions</SheetTitle>
            </SheetContent>
          </Sheet>
        </DialogContent>
      </Dialog>,
    );

    const trigger = screen.getByRole("button", { name: "Open permissions" });
    await user.click(trigger);
    const sheet = screen.getByRole("dialog", { name: "Permissions" });
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Permissions" })).toBeNull();
      expect(trigger).toHaveFocus();
    });
    expect(screen.getByRole("dialog", { name: "Connections" })).toBeVisible();
  });

  it("closes through the icon control and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open details</SheetTrigger>
        <SheetContent>
          <SheetTitle>Details</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    const trigger = screen.getByRole("button", { name: "Open details" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Details" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Details" })).toBeNull();
      expect(trigger).toHaveFocus();
    });
  });

  it("renders a visible overlay when nested in a dialog", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Parent dialog</DialogTitle>
          <Sheet open>
            <SheetContent>
              <SheetTitle>Nested sheet</SheetTitle>
            </SheetContent>
          </Sheet>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("dialog", { name: "Nested sheet" })).toBeVisible();
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toHaveClass(
      "bg-overlay/45",
      "transition-opacity",
      "data-ending-style:opacity-0",
    );
    expect(screen.getByRole("dialog", { name: "Nested sheet" })).toHaveClass(
      "transition-[translate,opacity]",
      "data-ending-style:translate-x-full",
      "data-ending-style:opacity-0",
    );
  });
});
