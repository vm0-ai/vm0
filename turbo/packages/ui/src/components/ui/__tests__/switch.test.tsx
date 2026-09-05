import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Switch } from "../switch";

describe("Switch", () => {
  it("uses the segmented-control track when unchecked", () => {
    render(<Switch aria-label="Notifications" />);

    expect(screen.getByRole("switch", { name: "Notifications" })).toHaveClass(
      "data-unchecked:bg-segment-track",
    );
  });
});
