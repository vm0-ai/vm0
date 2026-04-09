import { command, computed, state } from "ccstate";
import { zeroReportErrorContract, zeroRunsByIdContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { pathParams$ } from "../route.ts";
import { accept } from "../../lib/accept.ts";

// ---------------------------------------------------------------------------
// Route params
// ---------------------------------------------------------------------------

const reportErrorRunId$ = computed((get) => {
  const params = get(pathParams$) ?? {};
  return String(params.runId ?? "");
});

// ---------------------------------------------------------------------------
// Run data
// ---------------------------------------------------------------------------

export const reportErrorRun$ = computed(async (get) => {
  const runId = get(reportErrorRunId$);
  if (!runId) {
    return null;
  }
  const client = get(zeroClient$)(zeroRunsByIdContract);
  const result = await accept(
    client.getById({ params: { id: runId } }),
    [200],
    {
      toast: false,
    },
  );
  return result.body;
});

// ---------------------------------------------------------------------------
// User input state
// ---------------------------------------------------------------------------

const internalReportTitle$ = state("");
const internalReportDescription$ = state("");

export const reportTitle$ = computed((get) => {
  return get(internalReportTitle$);
});

export const reportDescription$ = computed((get) => {
  return get(internalReportDescription$);
});

export const setReportTitle$ = command(({ set }, title: string) => {
  set(internalReportTitle$, title);
});

export const setReportDescription$ = command(({ set }, description: string) => {
  set(internalReportDescription$, description);
});

// ---------------------------------------------------------------------------
// Submission state
// ---------------------------------------------------------------------------

type ReportState = "idle" | "loading" | "success" | "error";

const internalReportState$ = state<ReportState>("idle");
const internalReportReference$ = state<string | null>(null);
const internalReportErrorMessage$ = state<string | null>(null);

export const reportState$ = computed((get) => {
  return get(internalReportState$);
});

export const reportReference$ = computed((get) => {
  return get(internalReportReference$);
});

export const reportErrorMessage$ = computed((get) => {
  return get(internalReportErrorMessage$);
});

export const submitErrorReport$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const runId = get(reportErrorRunId$);
    if (!runId) {
      return;
    }

    const title = get(internalReportTitle$);
    const description = get(internalReportDescription$);
    if (!title) {
      return;
    }

    set(internalReportState$, "loading");
    set(internalReportErrorMessage$, null);

    const client = get(zeroClient$)(zeroReportErrorContract);
    const result = await client.submit({
      body: { runId, title, description: description || undefined },
    });

    if (result.status === 200) {
      set(internalReportState$, "success");
      set(internalReportReference$, result.body.reference);
    } else {
      set(internalReportState$, "error");
      const errorBody = result.body as { error?: { message?: string } };
      set(
        internalReportErrorMessage$,
        errorBody.error?.message ?? "Failed to submit error report",
      );
    }
  },
);

export const resetReportState$ = command(({ set }) => {
  set(internalReportState$, "idle");
  set(internalReportReference$, null);
  set(internalReportErrorMessage$, null);
  set(internalReportTitle$, "");
  set(internalReportDescription$, "");
});
