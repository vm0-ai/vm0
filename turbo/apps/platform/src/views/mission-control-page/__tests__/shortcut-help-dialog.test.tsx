import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShortcutHelpDialog } from "../shortcut-help-dialog.tsx";

// MC-D-001 — ShortcutHelpDialog display and content

describe("ShortcutHelpDialog", () => {
  it("renders dialog title and description when open", () => {
    render(<ShortcutHelpDialog open={true} onOpenChange={vi.fn()} />);

    expect(
      screen.getByRole("dialog", { name: /keyboard shortcuts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/available shortcuts in mission control/i),
    ).toBeInTheDocument();
  });

  it("renders all three shortcut sections", () => {
    render(<ShortcutHelpDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText("Global")).toBeInTheDocument();
    expect(screen.getByText("Task Card")).toBeInTheDocument();
    expect(screen.getByText("Task Panel")).toBeInTheDocument();
  });

  it("renders global shortcut labels", () => {
    render(<ShortcutHelpDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText("Show shortcuts")).toBeInTheDocument();
    expect(screen.getByText("Next task")).toBeInTheDocument();
    expect(screen.getByText("Previous task")).toBeInTheDocument();
    expect(screen.getByText("Toggle task list")).toBeInTheDocument();
    expect(screen.getByText("New chat")).toBeInTheDocument();
    expect(screen.getByText("Archive task")).toBeInTheDocument();
  });

  it("renders task card shortcut labels", () => {
    render(<ShortcutHelpDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText("Open task")).toBeInTheDocument();
    expect(screen.getByText("Toggle panel")).toBeInTheDocument();
  });

  it("renders task panel shortcut labels", () => {
    render(<ShortcutHelpDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText("Maximize / restore")).toBeInTheDocument();
    expect(screen.getByText("Back to task card")).toBeInTheDocument();
    expect(screen.getByText("Close panel")).toBeInTheDocument();
  });

  it("does not render dialog content when closed", () => {
    render(<ShortcutHelpDialog open={false} onOpenChange={vi.fn()} />);

    expect(
      screen.queryByRole("dialog", { name: /keyboard shortcuts/i }),
    ).not.toBeInTheDocument();
  });

  it("calls onOpenChange when dialog close is triggered", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(<ShortcutHelpDialog open={true} onOpenChange={onOpenChange} />);

    const closeButton = screen.getByLabelText("Close");
    await user.click(closeButton);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
