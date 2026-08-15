import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "../dialog";
import { Sheet, SheetContent, SheetTitle } from "../sheet";

describe("Sheet", () => {
  it("renders a visible overlay when nested in a dialog", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Parent dialog</DialogTitle>
          <Sheet open>
            <SheetContent overlayClassName="bg-overlay/45 backdrop-blur-sm dark:bg-overlay/55">
              <SheetTitle>Nested sheet</SheetTitle>
            </SheetContent>
          </Sheet>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("dialog", { name: "Nested sheet" })).toBeVisible();
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toHaveClass(
      "bg-overlay/45",
    );
  });
});
