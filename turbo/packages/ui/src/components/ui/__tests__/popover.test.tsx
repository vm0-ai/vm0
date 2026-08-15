import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "../dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";

describe("Popover", () => {
  it("nests its portal under the owning dialog portal", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Artifact preview</DialogTitle>
          <Popover open>
            <PopoverTrigger>Open menu</PopoverTrigger>
            <PopoverContent>Menu content</PopoverContent>
          </Popover>
        </DialogContent>
      </Dialog>,
    );

    const dialogPortal = screen
      .getByRole("dialog", { name: "Artifact preview" })
      .closest<HTMLElement>("[data-base-ui-portal]");
    const popoverPortal = screen
      .getByText("Menu content")
      .closest<HTMLElement>("[data-base-ui-portal]");

    expect(dialogPortal).toBeInTheDocument();
    expect(popoverPortal).toBeInTheDocument();
    expect(dialogPortal).not.toBe(popoverPortal);
    expect(dialogPortal).toContainElement(popoverPortal);
  });
});
