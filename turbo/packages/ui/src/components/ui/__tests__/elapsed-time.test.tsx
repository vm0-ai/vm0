import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElapsedTime } from "../elapsed-time";

describe("ElapsedTime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates an active elapsed time from the browser clock", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);

    render(
      <ElapsedTime startTime={800}>
        {(elapsedTime) => {
          return `${elapsedTime}ms`;
        }}
      </ElapsedTime>,
    );

    expect(screen.getByText("200ms")).toBeInTheDocument();

    now.mockReturnValue(1_300);
    await waitFor(
      () => {
        expect(screen.getByText("500ms")).toBeInTheDocument();
      },
      { timeout: 500 },
    );
  });

  it("stops updating when an end time is supplied", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_200);

    const view = render(
      <ElapsedTime startTime={1_000}>
        {(elapsedTime) => {
          return `${elapsedTime}ms`;
        }}
      </ElapsedTime>,
    );

    expect(screen.getByText("200ms")).toBeInTheDocument();

    view.rerender(
      <ElapsedTime startTime={1_000} endTime={1_450}>
        {(elapsedTime) => {
          return `${elapsedTime}ms`;
        }}
      </ElapsedTime>,
    );
    expect(screen.getByText("450ms")).toBeInTheDocument();

    now.mockReturnValue(20_000);
    await new Promise((resolve) => {
      window.setTimeout(resolve, 150);
    });
    expect(screen.getByText("450ms")).toBeInTheDocument();
  });

  it("clamps timestamps that precede the start time", () => {
    render(
      <ElapsedTime startTime={2_000} endTime={1_000}>
        {(elapsedTime) => {
          return `${elapsedTime}ms`;
        }}
      </ElapsedTime>,
    );

    expect(screen.getByText("0ms")).toBeInTheDocument();
  });
});
