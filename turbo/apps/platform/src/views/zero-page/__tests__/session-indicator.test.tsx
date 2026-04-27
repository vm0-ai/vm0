/**
 * Tests for SessionIndicator — the chat sidebar status indicator.
 *
 * Each state must render a distinct element so callers/tests can assert on
 * shape, not on color (color alone is not accessible).
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SessionIndicator } from "../session-indicator.tsx";

describe("SessionIndicator", () => {
  it("renders nothing for state 'none'", () => {
    const { container } = render(<SessionIndicator state="none" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the running spinner with role=status and aria-label", () => {
    const { getByRole } = render(<SessionIndicator state="running" />);
    const el = getByRole("status", { name: "Running" });
    expect(el).toHaveClass("animate-spin");
  });

  it("renders an unread dot when state='unread' and no count is given", () => {
    const { getByLabelText, queryByText } = render(
      <SessionIndicator state="unread" />,
    );
    expect(getByLabelText("Unread")).toBeInTheDocument();
    // Dot variant has no text content
    expect(queryByText(/\d+/)).not.toBeInTheDocument();
  });

  it("renders an unread badge with the count when state='unread' and count>0", () => {
    const { getByLabelText, getByText } = render(
      <SessionIndicator state="unread" unreadCount={3} />,
    );
    expect(getByLabelText("3 unread")).toBeInTheDocument();
    expect(getByText("3")).toBeInTheDocument();
  });

  it("clamps unread count overflow to '99+'", () => {
    const { getByText } = render(
      <SessionIndicator state="unread" unreadCount={120} />,
    );
    expect(getByText("99+")).toBeInTheDocument();
  });

  it("falls back to the dot variant when unreadCount is 0", () => {
    const { getByLabelText, queryByText } = render(
      <SessionIndicator state="unread" unreadCount={0} />,
    );
    expect(getByLabelText("Unread")).toBeInTheDocument();
    expect(queryByText("0")).not.toBeInTheDocument();
  });

  it("renders the pencil icon for state='draft'", () => {
    const { getByLabelText } = render(<SessionIndicator state="draft" />);
    // Tabler icons render as <svg> and forward aria-label to the root element.
    const el = getByLabelText("Draft");
    expect(el.tagName.toLowerCase()).toBe("svg");
  });
});
