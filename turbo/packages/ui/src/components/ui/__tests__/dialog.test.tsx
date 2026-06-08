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

    const overlay = document.querySelector(".zero-dialog-overlay");
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveClass("zero-dialog-overlay");
    expect(screen.getByRole("dialog", { name: "Default dialog" })).toHaveClass(
      "zero-dialog-content",
    );
  });
});
