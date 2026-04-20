import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../select";

describe("SelectItem", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("skips items with empty string value without throwing", () => {
    expect(() => {
      render(
        <Select defaultValue="ok" open>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Bad</SelectItem>
            <SelectItem value="ok">Good</SelectItem>
          </SelectContent>
        </Select>,
      );
    }).not.toThrow();
    const listbox = within(screen.getByRole("listbox"));
    expect(listbox.queryByText("Bad")).not.toBeInTheDocument();
    expect(listbox.getByText("Good")).toBeInTheDocument();
  });

  it("logs an error when value is empty so prod observability is preserved", () => {
    render(
      <Select defaultValue="ok" open>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">Bad</SelectItem>
          <SelectItem value="ok">Good</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("empty string `value`"),
    );
  });
});
