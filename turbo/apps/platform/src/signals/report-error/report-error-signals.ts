import { command, computed, state } from "ccstate";
import { zeroReportErrorContract } from "@vm0/api-contracts/contracts/zero-report-error";
import { zeroRunsByIdContract } from "@vm0/api-contracts/contracts/zero-runs";
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

const internalReportReference$ = state<string | null>(null);

export const reportReference$ = computed((get) => {
  return get(internalReportReference$);
});

export const submitErrorReport$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const runId = get(reportErrorRunId$);
    if (!runId) {
      return;
    }

    const title = get(internalReportTitle$);
    const description = get(internalReportDescription$);
    if (!title) {
      return;
    }

    const client = get(zeroClient$)(zeroReportErrorContract);
    const result = await accept(
      client.submit({
        body: { runId, title, description: description || undefined },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalReportReference$, result.body.reference);
  },
);

export const resetReportState$ = command(({ set }) => {
  set(internalReportReference$, null);
  set(internalReportTitle$, "");
  set(internalReportDescription$, "");
});
