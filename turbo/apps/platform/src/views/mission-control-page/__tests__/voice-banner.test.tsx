/**
 * Tests for VoiceButton and VoiceBanner components.
 *
 * VoiceButton renders in the Mission Control header; visibility is gated on the
 * voiceChat feature switch. VoiceBanner renders below the header and reflects
 * the live connection status driven by startMissionControlVoiceChat$.
 *
 * Test strategy:
 * - Feature switch state → controlled via setMockFeatureSwitches
 * - Connection status → driven by clicking "Voice On" and controlling the
 *   /api/zero/voice-chat POST + context-poll MSW handlers
 * - endVoiceChat$ (Dismiss) → verified by observing banner disappearance
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { setMockTasks } from "../../../mocks/handlers/api-tasks.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroVoiceChatSessionsContract,
  zeroVoiceChatContextContract,
} from "@vm0/core";

const context = testContext();

function mockEmptyTaskList() {
  setMockTasks([]);
}

// ---------------------------------------------------------------------------
// VoiceButton visibility
// ---------------------------------------------------------------------------

describe("voiceButton — feature switch off (MC-VC-001)", () => {
  it("is not rendered when voiceChat feature switch is disabled", async () => {
    mockEmptyTaskList();
    detachedSetupPage({ context, path: "/_/mission-control" });

    await waitFor(() => {
      expect(screen.getByText("No active tasks")).toBeInTheDocument();
    });

    expect(
      screen.queryAllByRole("button").find((el) => {
        return /Voice On/i.test(el.textContent ?? "");
      }),
    ).toBeUndefined();
  });
});

describe("voiceButton — feature switch on, idle status (MC-VC-002)", () => {
  it("renders 'Voice On' button when voiceChat feature switch is enabled", async () => {
    setMockFeatureSwitches({ voiceChat: true });
    mockEmptyTaskList();
    detachedSetupPage({ context, path: "/_/mission-control" });

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /Voice On/i.test(el.textContent ?? "");
        }),
      ).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// VoiceBanner — preparing state
// ---------------------------------------------------------------------------

describe("voiceBanner — preparing state (MC-VC-003)", () => {
  it("shows 'Enabling...' while session is being prepared", async () => {
    setMockFeatureSwitches({ voiceChat: true });
    const hangDeferred = createDeferredPromise<void>(context.signal);

    server.use(
      mockApi(zeroVoiceChatSessionsContract.create, ({ respond }) => {
        return respond(200, {
          session: {
            id: "vc-prep-session",
            mode: "chat",
            status: "preparing",
            runId: "run-test-1",
            createdAt: "2026-01-01T00:00:00Z",
            prepared: false,
          },
        });
      }),
      // Hang the context poll so status stays "preparing"
      mockApi(zeroVoiceChatContextContract.getEvents, async ({ respond }) => {
        await hangDeferred.promise;
        return respond(200, { events: [] });
      }),
    );

    const user = userEvent.setup();
    detachedSetupPage({ context, path: "/_/mission-control" });

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /Voice On/i.test(el.textContent ?? "");
        }),
      ).toBeDefined();
    });

    await user.click(
      screen.getAllByRole("button").find((el) => {
        return /Voice On/i.test(el.textContent ?? "");
      })!,
    );

    await waitFor(() => {
      expect(screen.getByText("Enabling...")).toBeInTheDocument();
    });

    hangDeferred.resolve();
  });
});

// ---------------------------------------------------------------------------
// VoiceBanner — error state
// ---------------------------------------------------------------------------

describe("voiceBanner — error on session creation (MC-VC-004)", () => {
  it("shows 'Voice error' and Dismiss when the POST /api/zero/voice-chat fails", async () => {
    setMockFeatureSwitches({ voiceChat: true });

    server.use(
      mockApi(zeroVoiceChatSessionsContract.create, ({ respond }) => {
        return respond(400, {
          error: { message: "Service unavailable", code: "BAD_REQUEST" },
        });
      }),
    );

    const user = userEvent.setup();
    detachedSetupPage({ context, path: "/_/mission-control" });

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /Voice On/i.test(el.textContent ?? "");
        }),
      ).toBeDefined();
    });

    await user.click(
      screen.getAllByRole("button").find((el) => {
        return /Voice On/i.test(el.textContent ?? "");
      })!,
    );

    await waitFor(() => {
      expect(screen.getByText("Voice error")).toBeInTheDocument();
    });
    expect(
      screen.getAllByRole("button").find((el) => {
        return el.textContent === "Dismiss";
      }),
    ).toBeDefined();
  });
});

describe("voiceBanner — dismiss error restores idle (MC-VC-005)", () => {
  it("hides error banner and shows Voice On again when Dismiss is clicked", async () => {
    setMockFeatureSwitches({ voiceChat: true });

    server.use(
      mockApi(zeroVoiceChatSessionsContract.create, ({ respond }) => {
        return respond(400, {
          error: { message: "fail", code: "BAD_REQUEST" },
        });
      }),
      // endVoiceChat$ fires a best-effort POST to /end — let it succeed silently
      mockApi(zeroVoiceChatSessionsContract.end, ({ respond }) => {
        return respond(200, { ok: true });
      }),
    );

    const user = userEvent.setup();
    detachedSetupPage({ context, path: "/_/mission-control" });

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /Voice On/i.test(el.textContent ?? "");
        }),
      ).toBeDefined();
    });

    await user.click(
      screen.getAllByRole("button").find((el) => {
        return /Voice On/i.test(el.textContent ?? "");
      })!,
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent === "Dismiss";
        }),
      ).toBeDefined();
    });
    const dismiss = screen.getAllByRole("button").find((el) => {
      return el.textContent === "Dismiss";
    })!;
    await user.click(dismiss);

    await waitFor(() => {
      expect(screen.queryByText("Voice error")).toBeNull();
    });
    // Button restored to idle state
    expect(
      screen.getAllByRole("button").find((el) => {
        return /Voice On/i.test(el.textContent ?? "");
      }),
    ).toBeDefined();
  });
});
