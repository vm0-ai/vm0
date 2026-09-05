import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "../dialog";

describe("Dialog", () => {
  it("applies the default dialog animation classes", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Default dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const overlay = document.querySelector(".okou-dialog-overlay");
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveClass("okou-dialog-overlay");
    expect(screen.getByRole("dialog", { name: "Default dialog" })).toHaveClass(
      "okou-dialog-content",
    );
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

    expect(document.querySelectorAll(".okou-dialog-overlay")).toHaveLength(2);
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
