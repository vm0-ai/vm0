/**
 * Display tests for router.tsx, error-boundary.tsx, default-error-boundary.tsx,
 * and main.tsx.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { ErrorBoundary } from "../../error-boundary.tsx";
import { showAppSkeleton$ } from "../../../signals/app-skeleton.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import type { ErrorInfo, ReactElement } from "react";

const context = testContext();

function ThrowError({ message }: { message: string }): never {
  throw new Error(message);
}

describe("main - toaster", () => {
  it("toast notification container renders with top-center position (INFRA-D-001)", async () => {
    detachedSetupPage({
      context,
      path: "/_/error",
    });

    // Trigger a toast so the <ol data-sonner-toaster> element renders.
    // Sonner only renders the positioned list when there are active toasts.
    toast("test");

    await waitFor(() => {
      const toaster = document.querySelector<HTMLElement>(
        "[data-sonner-toaster]",
      );
      expect(toaster).not.toBeNull();
      expect(toaster?.dataset.yPosition).toBe("top");
      expect(toaster?.dataset.xPosition).toBe("center");
    });
  });
});

describe("router - app skeleton", () => {
  it("appSkeleton shows when skeletonVisible is true (INFRA-D-003)", async () => {
    detachedSetupPage({
      context,
      path: "/_/error",
    });

    context.store.set(showAppSkeleton$);

    await waitFor(() => {
      const skeleton = screen.getByTestId("app-skeleton");
      expect(skeleton).not.toHaveAttribute("aria-hidden");
    });
  });

  it("appSkeleton hides once page loads (INFRA-D-004)", async () => {
    detachedSetupPage({
      context,
      path: "/_/error",
    });

    await waitFor(() => {
      const skeleton = screen.getByTestId("app-skeleton");
      expect(skeleton).toHaveAttribute("aria-hidden", "true");
    });
  });
});

// Error boundary tests use createRoot directly (bypassing @testing-library/react's act() wrapper).
// @testing-library/react wraps all renders in act(), and React 19 inside act() pushes error
// boundary errors to thrownErrors which act() re-throws synchronously, making it impossible
// to test error boundaries via the standard render() call.
//
// Instead we:
// 1. Use createRoot directly (no act() wrapper) to render the error boundary
// 2. Suppress console.error (setup.ts spy throws on console.error; ErrorBoundary.componentDidCatch
//    calls it) with a spy
// 3. Suppress window error events (React 19 always dispatches these for caught errors too)
//    by adding a listener that calls preventDefault() on the event
const suppressWindowError = (e: ErrorEvent) => {
  e.preventDefault();
};

function renderWithRoot(ui: ReactElement): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onCaughtError: () => {} });
  root.render(ui);
  return {
    container,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

describe("error boundary", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    window.addEventListener("error", suppressWindowError);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    window.removeEventListener("error", suppressWindowError);
  });

  it("error object displays in fallback (INFRA-D-005)", async () => {
    const { unmount } = renderWithRoot(
      <ErrorBoundary
        fallback={({ error }) => {
          return <div data-testid="error-msg">{error.message}</div>;
        }}
      >
        <ThrowError message="test-error-object" />
      </ErrorBoundary>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("error-msg")).toHaveTextContent(
        "test-error-object",
      );
    });
    unmount();
  });

  it("error info displays in fallback (INFRA-D-006)", async () => {
    const { unmount } = renderWithRoot(
      <ErrorBoundary
        fallback={({ errorInfo }: { errorInfo: ErrorInfo }) => {
          return (
            <div data-testid="error-info">
              {errorInfo.componentStack ?? "no-stack"}
            </div>
          );
        }}
      >
        <ThrowError message="test-error-info" />
      </ErrorBoundary>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("error-info")).not.toHaveTextContent(
        "no-stack",
      );
    });
    unmount();
  });

  it("sentry event ID renders in fallback (INFRA-D-007)", async () => {
    const { unmount } = renderWithRoot(
      <ErrorBoundary
        fallback={({ sentryEventId }) => {
          return (
            <div data-testid="event-id">{sentryEventId ?? "no-event-id"}</div>
          );
        }}
      >
        <ThrowError message="sentry-event-test" />
      </ErrorBoundary>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("event-id")).not.toHaveTextContent(
        "no-event-id",
      );
    });
    unmount();
  });

  it("children render normally when no error; fallback renders on error (INFRA-D-008)", async () => {
    const { unmount: unmountA } = renderWithRoot(
      <ErrorBoundary
        fallback={() => {
          return <div data-testid="fallback">fallback</div>;
        }}
      >
        <div data-testid="children">normal content</div>
      </ErrorBoundary>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("children")).toBeInTheDocument();
      expect(screen.queryByTestId("fallback")).not.toBeInTheDocument();
    });
    unmountA();

    const { unmount: unmountB } = renderWithRoot(
      <ErrorBoundary
        fallback={() => {
          return <div data-testid="fallback">fallback</div>;
        }}
      >
        <ThrowError message="trigger-fallback" />
      </ErrorBoundary>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("fallback")).toBeInTheDocument();
      expect(screen.queryByTestId("children")).not.toBeInTheDocument();
    });
    unmountB();
  });

  it("static error message renders in DefaultErrorFallback (INFRA-D-009)", async () => {
    const { unmount } = renderWithRoot(
      <ErrorBoundary>
        <ThrowError message="default-fallback-test" />
      </ErrorBoundary>,
    );

    await waitFor(() => {
      expect(
        screen.getByText("Oops! Something went sideways"),
      ).toBeInTheDocument();
    });
    unmount();
  });
});
