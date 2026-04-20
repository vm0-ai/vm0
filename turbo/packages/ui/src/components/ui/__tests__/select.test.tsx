import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../select";

describe("SelectItem", () => {
  it("renders items with non-empty values", () => {
    render(
      <Select defaultValue="a" open>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
          <SelectItem value="b">Beta</SelectItem>
        </SelectContent>
      </Select>,
    );
    const listbox = within(screen.getByRole("listbox"));
    expect(listbox.getByText("Alpha")).toBeInTheDocument();
    expect(listbox.getByText("Beta")).toBeInTheDocument();
  });
});
