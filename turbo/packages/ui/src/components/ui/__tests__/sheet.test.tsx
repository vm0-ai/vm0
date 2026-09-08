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
