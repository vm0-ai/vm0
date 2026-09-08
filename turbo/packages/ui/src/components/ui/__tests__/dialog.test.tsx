import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "../dialog";

describe("Dialog", () => {
  it("applies Base UI animations that run on initial mount", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Default dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass(
      "data-open:animate-[okou-dialog-backdrop-in_150ms_ease-out]",
      "data-closed:animate-[okou-dialog-backdrop-out_150ms_ease-out]",
      "motion-reduce:animate-none",
    );
    expect(screen.getByRole("dialog", { name: "Default dialog" })).toHaveClass(
      "data-open:animate-[okou-dialog-popup-in_150ms_ease-out]",
      "data-closed:animate-[okou-dialog-popup-out_150ms_ease-out]",
      "motion-reduce:animate-none",
    );
    expect(
      screen.getByRole("dialog", { name: "Default dialog" }),
    ).toHaveAttribute("data-open");
  });

  it("renders an overlay for nested dialogs", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Parent dialog</DialogTitle>
          <Dialog open>
            <DialogContent>
              <DialogTitle>Nested dialog</DialogTitle>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>,
    );

    expect(
      document.querySelectorAll('[data-slot="dialog-overlay"]'),
    ).toHaveLength(2);
  });

  it("can leave close controls to a custom dialog header", () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Custom header dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});
