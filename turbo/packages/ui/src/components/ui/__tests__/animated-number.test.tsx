import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnimatedNumber } from "../animated-number";

function animatedValue(container: HTMLElement): string | null {
  return (
    container.querySelector(".animated-number-measure")?.textContent ?? null
  );
}

describe("AnimatedNumber", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an exact formatted value immediately", () => {
    const { container } = render(
      <AnimatedNumber
        value={3530}
        formatValue={(value) => {
          return value.toLocaleString("en-US");
        }}
      />,
    );

    expect(animatedValue(container)).toBe("3,530");
  });

  it("logarithmically approaches a random pending target until a value resolves", () => {
    let nextFrame: FrameRequestCallback | undefined;
    let nextFrameId = 0;
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
      media: "",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame = callback;
      nextFrameId += 1;
      return nextFrameId;
    });
    const cancelAnimationFrame = vi.spyOn(window, "cancelAnimationFrame");

    const { container, rerender } = render(
      <AnimatedNumber value={null} pendingTargetRange={[300, 400]} />,
    );

    expect(animatedValue(container)).toBe("0");
    act(() => {
      nextFrame?.(800);
    });
    expect(animatedValue(container)).toBe("337");

    rerender(<AnimatedNumber value={3530} pendingTargetRange={[300, 400]} />);
    expect(animatedValue(container)).toBe("3530");
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
  });
});
