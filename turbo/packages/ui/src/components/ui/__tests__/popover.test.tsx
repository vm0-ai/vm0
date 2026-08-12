import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Popover, PopoverContent, PopoverTrigger } from "../popover";

describe("Popover", () => {
  it("applies a caller-provided positioner layer", () => {
    render(
      <Popover open>
        <PopoverTrigger>Open menu</PopoverTrigger>
        <PopoverContent positionerClassName="!z-[10000]">
          Menu content
        </PopoverContent>
      </Popover>,
    );

    expect(screen.getByText("Menu content").parentElement).toHaveClass(
      "!z-[10000]",
    );
  });
});
