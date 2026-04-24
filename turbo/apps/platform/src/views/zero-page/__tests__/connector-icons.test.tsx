/**
 * Tests for connector-icons.tsx
 *
 * Tests the ConnectorIcon component and icon mapping utilities.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectorIcon, CONNECTOR_ICONS } from "../components/settings/connector-icons.tsx";
import { CONNECTOR_TYPES } from "@vm0/core/contracts/connectors";

describe("CONNECTOR_ICONS", () => {
  it("should have an entry for every connector type", () => {
    const connectorTypes = Object.keys(CONNECTOR_TYPES) as Array<
      keyof typeof CONNECTOR_TYPES
    >;
    for (const type of connectorTypes) {
      expect(CONNECTOR_ICONS[type]).toBeDefined();
      expect(typeof CONNECTOR_ICONS[type]).toBe("string");
      expect(CONNECTOR_ICONS[type].length).toBeGreaterThan(0);
    }
  });

  it("should contain url strings for each icon", () => {
    const connectorTypes = Object.keys(CONNECTOR_TYPES) as Array<
      keyof typeof CONNECTOR_TYPES
    >;
    for (const type of connectorTypes) {
      const icon = CONNECTOR_ICONS[type];
      expect(icon).toMatch(/^https?:\/\//);
    }
  });
});

describe("ConnectorIcon component", () => {
  it("should render with default size", () => {
    render(<ConnectorIcon type="github" />);
    const img = screen.getByRole("img");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("alt", "");
  });

  it("should render with custom size", () => {
    render(<ConnectorIcon type="github" size={40} />);
    const span = screen.getByRole("img").parentElement;
    expect(span).toHaveStyle({ width: "40px", height: "40px" });
  });

  it("should render slack icon with overflow-hidden container", () => {
    render(<ConnectorIcon type="slack" />);
    const span = screen.getByRole("img").parentElement;
    expect(span).toHaveClass("overflow-hidden");
  });

  it("should render slack-webhook icon with overflow-hidden container", () => {
    render(<ConnectorIcon type="slack-webhook" />);
    const span = screen.getByRole("img").parentElement;
    expect(span).toHaveClass("overflow-hidden");
  });

  it("should apply zero-icon-mono to non-colorful icons", () => {
    render(<ConnectorIcon type="github" />);
    const img = screen.getByRole("img");
    expect(img).toHaveClass("zero-icon-mono");
  });

  it("should not apply zero-icon-mono to colorful icons", () => {
    render(<ConnectorIcon type="anthropic" />);
    const img = screen.getByRole("img");
    expect(img).not.toHaveClass("zero-icon-mono");
  });

  it("should scale slack icon (has loose viewbox)", () => {
    render(<ConnectorIcon type="slack" size={28} />);
    const img = screen.getByRole("img");
    expect(img).toHaveClass("scale-[2.2]");
  });

  it("should render deel connector with custom SVG mark", () => {
    render(<ConnectorIcon type="deel" />);
    // Deel has a special inline SVG component, not an <img>
    const svg = screen.getByRole("img");
    expect(svg).toBeInTheDocument();
  });

  it("should render all common connector types without crashing", () => {
    const commonTypes = [
      "github",
      "slack",
      "jira",
      "linear",
      "notion",
      "google-drive",
      "anthropic",
      "openai",
    ] as const;

    for (const type of commonTypes) {
      if (CONNECTOR_ICONS[type]) {
        const { unmount } = render(<ConnectorIcon type={type} />);
        expect(screen.getByRole("img")).toBeInTheDocument();
        unmount();
      }
    }
  });
});
