import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Switch } from "../switch";

describe("Switch", () => {
  it("deepens only the new UI checked track by one Amber step", () => {
    render(<Switch aria-label="Notifications" />);

    expect(screen.getByRole("switch", { name: "Notifications" })).toHaveClass(
      "data-checked:bg-primary",
      "new-ui:data-checked:bg-primary-400",
      "data-unchecked:bg-muted",
    );
  });
});
