import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "../badge";

describe("Badge", () => {
  it("renders its label in a span by default", () => {
    render(<Badge>Admin</Badge>);

    const badge = screen.getByText("Admin");
    expect(badge.tagName).toBe("SPAN");
    expect(badge).toHaveAttribute("data-slot", "badge");
  });

  it("composes the host element the caller supplies", () => {
    render(<Badge render={<code />}>0.882.5</Badge>);

    const badge = screen.getByText("0.882.5");
    expect(badge.tagName).toBe("CODE");
    expect(badge.querySelector("span")).toBeNull();
  });

  it("keeps the caller's classes alongside the shared ones", () => {
    render(<Badge className="text-muted-foreground">Pending</Badge>);

    const badge = screen.getByText("Pending");
    expect(badge).toHaveClass("text-muted-foreground");
    expect(badge).toHaveClass("border-surface-border");
  });

  it("lets the caller override the slot and forwards other attributes", () => {
    render(
      <Badge data-slot="status-badge" data-status="completed">
        Completed
      </Badge>,
    );

    const badge = screen.getByText("Completed");
    expect(badge).toHaveAttribute("data-slot", "status-badge");
    expect(badge).toHaveAttribute("data-status", "completed");
  });

  it("forwards ref to the rendered element", () => {
    const ref = { current: null as HTMLElement | null };
    render(<Badge ref={ref}>Legacy</Badge>);

    expect(ref.current).toBe(screen.getByText("Legacy"));
  });
});
