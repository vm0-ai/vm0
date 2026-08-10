import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnimatedNumber } from "../animated-number";

function animatedValue(container: HTMLElement): string | null {
  return (
    container.querySelector(".animated-number-measure")?.textContent ?? null
  );
}

function mockAnimationFrames(): {
  frames: FrameRequestCallback[];
  requestAnimationFrame: ReturnType<typeof vi.spyOn>;
  cancelAnimationFrame: ReturnType<typeof vi.spyOn>;
} {
  const frames: FrameRequestCallback[] = [];
  let nextFrameId = 0;
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
  const requestAnimationFrame = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback);
      nextFrameId += 1;
      return nextFrameId;
    });
  const cancelAnimationFrame = vi.spyOn(window, "cancelAnimationFrame");
  return { frames, requestAnimationFrame, cancelAnimationFrame };
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
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { frames, cancelAnimationFrame } = mockAnimationFrames();

    const { container, rerender } = render(
      <AnimatedNumber value={null} pendingTargetRange={[300, 400]} />,
    );

    expect(animatedValue(container)).toBe("0");
    act(() => {
      frames[0]?.(800);
    });
    expect(animatedValue(container)).toBe("337");

    rerender(<AnimatedNumber value={3530} pendingTargetRange={[300, 400]} />);
    expect(animatedValue(container)).toBe("3530");
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
  });

  it("stops requesting frames after reaching the pending plateau", () => {
    const { frames, requestAnimationFrame } = mockAnimationFrames();
    const { container } = render(
      <AnimatedNumber value={null} pendingTargetRange={[350, 350]} />,
    );

    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    act(() => {
      frames[0]?.(8000);
    });

    expect(animatedValue(container)).toBe("349");
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
  });
});
