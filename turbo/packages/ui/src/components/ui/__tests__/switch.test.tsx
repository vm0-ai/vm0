import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Switch } from "../switch";

describe("Switch", () => {
  it("deepens only the new UI unchecked track by one neutral step", () => {
    render(<Switch aria-label="Notifications" />);

    expect(screen.getByRole("switch", { name: "Notifications" })).toHaveClass(
      "data-unchecked:bg-muted",
      "new-ui:data-unchecked:bg-gray-300",
    );
  });
});
