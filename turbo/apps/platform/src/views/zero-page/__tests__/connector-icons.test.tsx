/**
 * Tests for connector-icons.tsx
 *
 * Tests the ConnectorIcon component and icon mapping utilities.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  ConnectorIcon,
  CONNECTOR_ICONS,
} from "../components/settings/connector-icons.tsx";
import { CONNECTOR_TYPES } from "@vm0/connectors/connectors";

describe("connector icons", () => {
  it("should have an entry for every connector type", () => {
    const connectorTypes = Object.keys(
      CONNECTOR_TYPES,
    ) as (keyof typeof CONNECTOR_TYPES)[];
    for (const type of connectorTypes) {
      expect(CONNECTOR_ICONS[type]).toBeDefined();
      expect(typeof CONNECTOR_ICONS[type]).toBe("string");
      expect(CONNECTOR_ICONS[type].length).toBeGreaterThan(0);
    }
  });

  it("should contain data URL or asset path strings for each icon", () => {
    const connectorTypes = Object.keys(
      CONNECTOR_TYPES,
    ) as (keyof typeof CONNECTOR_TYPES)[];
    for (const type of connectorTypes) {
      const icon = CONNECTOR_ICONS[type];
      expect(typeof icon).toBe("string");
      expect(icon.length).toBeGreaterThan(0);
      expect(icon).toMatch(/^(?:data:image\/|\.\.?\/|\/)/);
    }
  });
});

describe("connector icon component", () => {
  it("should render with default size", () => {
    const { container } = render(<ConnectorIcon type="github" />);
    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("alt", "");
  });

  it("should render with custom size", () => {
    const { container } = render(<ConnectorIcon type="github" size={40} />);
    const img = container.querySelector("img");
    const span = img!.parentElement;
    expect(span).toHaveStyle({ width: "40px", height: "40px" });
  });

  it("should render slack icon with overflow-hidden container", () => {
    const { container } = render(<ConnectorIcon type="slack" />);
    const img = container.querySelector("img");
    const span = img!.parentElement;
    expect(span).toHaveClass("overflow-hidden");
  });

  it("should render slack-webhook icon with overflow-hidden container", () => {
    const { container } = render(<ConnectorIcon type="slack-webhook" />);
    const img = container.querySelector("img");
    const span = img!.parentElement;
    expect(span).toHaveClass("overflow-hidden");
  });

  it("should apply zero-icon-mono to non-colorful icons", () => {
    const { container } = render(<ConnectorIcon type="github" />);
    const img = container.querySelector("img");
    expect(img).toHaveClass("zero-icon-mono");
  });

  it("should not apply zero-icon-mono to colorful icons", () => {
    for (const type of [
      "slack",
      "groq",
      "browserstack",
      "explorium",
      "servicenow",
    ] as const) {
      const { container, unmount } = render(<ConnectorIcon type={type} />);
      const img = container.querySelector("img");
      expect(img).not.toHaveClass("zero-icon-mono");
      unmount();
    }
  });

  it("should scale slack icon (has loose viewbox)", () => {
    const { container } = render(<ConnectorIcon type="slack" size={28} />);
    const img = container.querySelector("img");
    expect(img).toHaveClass("scale-[2.2]");
  });

  it("should render deel connector with custom SVG mark", () => {
    const { container } = render(<ConnectorIcon type="deel" />);
    // Deel has a special inline SVG component, not an <img>
    const svg = container.querySelector("svg");
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
      "anthropic-managed-agents",
      "openai",
    ] as const;

    for (const type of commonTypes) {
      if (CONNECTOR_ICONS[type]) {
        const { container, unmount } = render(<ConnectorIcon type={type} />);
        expect(container.querySelector("img")).toBeInTheDocument();
        unmount();
      }
    }
  });
});
