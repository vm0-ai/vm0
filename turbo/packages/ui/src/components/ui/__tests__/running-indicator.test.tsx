/// <reference types="node" />

import { render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunningIndicator } from "../running-indicator";

const packageStylesPath = resolve(process.cwd(), "src/styles/globals.css");
const globalsCss = readFileSync(
  existsSync(packageStylesPath)
    ? packageStylesPath
    : resolve(process.cwd(), "packages/ui/src/styles/globals.css"),
  "utf8",
);

function getCssBlock(selector: string) {
  const selectorIndex = globalsCss.indexOf(selector);
  if (selectorIndex === -1) {
    throw new Error(`Missing CSS selector ${selector}`);
  }
  const openingBraceIndex = globalsCss.indexOf("{", selectorIndex);
  let depth = 0;

  for (let index = openingBraceIndex; index < globalsCss.length; index += 1) {
    if (globalsCss[index] === "{") {
      depth += 1;
    } else if (globalsCss[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return globalsCss.slice(openingBraceIndex + 1, index);
      }
    }
  }

  throw new Error(`Missing CSS block for ${selector}`);
}

describe("RunningIndicator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the center and ripple layers concentric", () => {
    render(<RunningIndicator />);

    const indicator = screen.getByLabelText("Running");
    const center = indicator.querySelector(".running-indicator-center");
    const ripple = indicator.querySelector(".running-indicator-ripple");

    expect(center).toBeInTheDocument();
    expect(ripple).toBeInTheDocument();

    const centerRule = getCssBlock(".running-indicator-center");
    const rippleRule = getCssBlock(".running-indicator-ripple");
    const centerKeyframes = getCssBlock("@keyframes running-indicator-center");
    const rippleKeyframes = getCssBlock("@keyframes running-indicator-ripple");

    expect(centerRule).toContain("top: 50%");
    expect(centerRule).toContain("left: 50%");
    expect(rippleRule).toContain("top: 50%");
    expect(rippleRule).toContain("left: 50%");
    expect(centerRule).toContain("transform: translate(-50%, -50%)");
    expect(rippleRule).toContain("transform: translate(-50%, -50%)");
    expect(centerKeyframes).not.toMatch(/transform:(?![^;]*translate\()/);
    expect(rippleKeyframes).not.toMatch(/transform:(?![^;]*translate\()/);
  });

  it("keeps a distinct resting state before animations start", () => {
    render(<RunningIndicator />);

    const centerRule = getCssBlock(".running-indicator-center");
    const rippleRule = getCssBlock(".running-indicator-ripple");

    expect(centerRule).toContain(
      "transform: translate(-50%, -50%) scale(0.64)",
    );
    expect(centerRule).toContain("opacity: 0.34");
    expect(rippleRule).toContain("transform: translate(-50%, -50%) scale(0.8)");
    expect(rippleRule).toContain("opacity: 0");
  });

  it("keeps indicators mounted at different times on one pulse phase", () => {
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(125);
    const first = render(<RunningIndicator label="First running" />);

    now.mockReturnValue(725);
    const second = render(<RunningIndicator label="Second running" />);

    const firstDelay = Number.parseInt(
      first
        .getByLabelText("First running")
        .style.getPropertyValue("--running-indicator-delay"),
      10,
    );
    const secondDelay = Number.parseInt(
      second
        .getByLabelText("Second running")
        .style.getPropertyValue("--running-indicator-delay"),
      10,
    );

    const observationTime = 800;
    const firstPhase = observationTime - 125 - firstDelay;
    const secondPhase = observationTime - 725 - secondDelay;

    expect(firstPhase).toBe(observationTime);
    expect(secondPhase).toBe(observationTime);
  });
});
