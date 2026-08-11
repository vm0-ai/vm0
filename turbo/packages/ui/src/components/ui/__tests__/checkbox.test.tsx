import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Checkbox } from "../checkbox";

describe("Checkbox", () => {
  it("preserves the legacy indeterminate checked state", () => {
    render(<Checkbox checked="indeterminate" aria-label="Select all" />);

    const checkbox = screen.getByRole("checkbox", { name: "Select all" });
    expect(checkbox).toHaveAttribute("aria-checked", "mixed");
    expect(checkbox).toHaveAttribute("data-indeterminate");
  });
});
