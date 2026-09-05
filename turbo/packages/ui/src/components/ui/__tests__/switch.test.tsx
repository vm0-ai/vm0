import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Switch } from "../switch";

describe("Switch", () => {
  it("uses the new UI Amber and segment track tokens", () => {
    render(<Switch aria-label="Notifications" />);

    expect(screen.getByRole("switch", { name: "Notifications" })).toHaveClass(
      "data-checked:bg-primary",
      "new-ui:data-checked:bg-primary-400",
      "data-unchecked:bg-muted",
      "new-ui:data-unchecked:bg-segment-track",
    );
  });
});
