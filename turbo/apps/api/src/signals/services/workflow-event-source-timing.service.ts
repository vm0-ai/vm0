import { now } from "../external/time";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
  type ApiDispatchTimingActionType,
  type ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";

type WorkflowEventSource =
  | "github"
  | "gmail"
  | "google_calendar"
  | "google_meet"
  | "webhook";

type WorkflowEventSourceTimingActionType = Extract<
  ApiDispatchTimingActionType,
  `api_dispatch_pre_create_zero_workflow_event_${string}`
>;

interface WorkflowEventSourceTimingRecord {
  readonly actionType: WorkflowEventSourceTimingActionType;
  readonly startedAt: number;
  readonly finishedAt: number;
}

function workflowEventSourceDimensions(
  source: WorkflowEventSource,
): ApiDispatchTimingDimensions {
  return { workflow_event_source: source };
}

export class WorkflowEventSourceTiming {
  private readonly records: WorkflowEventSourceTimingRecord[];

  constructor(
    private readonly source: WorkflowEventSource,
    private readonly apiStartTime: number,
    records: readonly WorkflowEventSourceTimingRecord[] = [],
  ) {
    this.records = [...records];
  }

  recordElapsed(
    actionType: WorkflowEventSourceTimingActionType,
    startedAt: number,
    finishedAt: number = now(),
  ): void {
    this.records.push({ actionType, startedAt, finishedAt });
  }

  async measure<T>(
    actionType: WorkflowEventSourceTimingActionType,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const startedAt = now();
    const result = await operation();
    this.recordElapsed(actionType, startedAt);
    return result;
  }

  createRunTiming(): WorkflowEventRunTiming {
    return new WorkflowEventRunTiming(
      this.source,
      this.apiStartTime,
      this.records,
    );
  }

  fork(): WorkflowEventSourceTiming {
    return new WorkflowEventSourceTiming(
      this.source,
      this.apiStartTime,
      this.records,
    );
  }
}

export class WorkflowEventRunTiming {
  private readonly collector = new ApiDispatchTimingCollector();
  private finalized = false;

  constructor(
    private readonly source: WorkflowEventSource,
    private readonly apiStartTime: number,
    records: readonly WorkflowEventSourceTimingRecord[],
  ) {
    for (const record of records) {
      this.recordElapsed(
        record.actionType,
        record.startedAt,
        record.finishedAt,
      );
    }
  }

  recordElapsed(
    actionType: WorkflowEventSourceTimingActionType,
    startedAt: number,
    finishedAt: number = now(),
  ): void {
    this.collector.recordElapsed(
      actionType,
      "nested",
      startedAt,
      finishedAt,
      workflowEventSourceDimensions(this.source),
    );
  }

  async measure<T>(
    actionType: WorkflowEventSourceTimingActionType,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    return await measureApiDispatchTiming(
      this.collector,
      actionType,
      "nested",
      operation,
      workflowEventSourceDimensions(this.source),
    );
  }

  collectorForRunStart(): ApiDispatchTimingCollector {
    if (!this.finalized) {
      const finishedAt = now();
      this.recordElapsed(
        "api_dispatch_pre_create_zero_workflow_event_handoff_run",
        finishedAt,
        finishedAt,
      );
      this.collector.recordElapsed(
        "api_dispatch_pre_create_zero_workflow_trigger_entrypoint_gap",
        "nested",
        this.apiStartTime,
        finishedAt,
        workflowEventSourceDimensions(this.source),
      );
      this.finalized = true;
    }
    return this.collector;
  }
}
