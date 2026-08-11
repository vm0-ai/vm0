import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Checkbox } from "../checkbox";

describe("Checkbox", () => {
  it("allows an uncontrolled checkbox to be toggled", async () => {
    const user = userEvent.setup();
    render(<Checkbox aria-label="Email notifications" />);

    const checkbox = screen.getByRole("checkbox", {
      name: "Email notifications",
    });
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);

    expect(checkbox).toBeChecked();
  });

  it("preserves the legacy indeterminate checked state", () => {
    render(<Checkbox checked="indeterminate" aria-label="Select all" />);

    const checkbox = screen.getByRole("checkbox", { name: "Select all" });
    expect(checkbox).toHaveAttribute("aria-checked", "mixed");
    expect(checkbox).toHaveAttribute("data-indeterminate");
  });
});
