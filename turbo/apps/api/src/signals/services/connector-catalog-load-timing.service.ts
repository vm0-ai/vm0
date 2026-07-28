import type {
  ApiDispatchTimingActionType,
  ApiDispatchTimingCollector,
  ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";

type AcceptedConnectorCatalogCacheOutcome = "hit" | "miss" | "in_flight";
type ConnectorRuntimeSnapshotCacheOutcome = "hit" | "miss";
type ConnectorCatalogValidationResult =
  | { readonly outcome: "attested" }
  | {
      readonly outcome: "full_fallback";
      readonly fallbackReason: "missing_authority" | "different_authority";
    }
  | { readonly outcome: "not_run" };

type ConnectorCatalogCountBucket =
  | "0"
  | "1"
  | "2_4"
  | "5_8"
  | "9_16"
  | "17_plus";
type ConnectorCatalogRawSizeBucket =
  | "0_255_kib"
  | "256_511_kib"
  | "512_1023_kib"
  | "1_2_mib"
  | "2_4_mib"
  | "4_8_mib";

function countBucket(count: number): ConnectorCatalogCountBucket {
  if (count === 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  if (count <= 8) {
    return "5_8";
  }
  if (count <= 16) {
    return "9_16";
  }
  return "17_plus";
}

function rawSizeBucket(rawSize: number): ConnectorCatalogRawSizeBucket {
  if (rawSize < 256 * 1024) {
    return "0_255_kib";
  }
  if (rawSize < 512 * 1024) {
    return "256_511_kib";
  }
  if (rawSize < 1024 * 1024) {
    return "512_1023_kib";
  }
  if (rawSize < 2 * 1024 * 1024) {
    return "1_2_mib";
  }
  if (rawSize < 4 * 1024 * 1024) {
    return "2_4_mib";
  }
  return "4_8_mib";
}

function acceptedCacheOutcomeRank(
  outcome: AcceptedConnectorCatalogCacheOutcome,
): number {
  switch (outcome) {
    case "hit": {
      return 0;
    }
    case "in_flight": {
      return 1;
    }
    case "miss": {
      return 2;
    }
  }
}

export class ConnectorCatalogLoadTiming {
  private acceptedCacheOutcome:
    | AcceptedConnectorCatalogCacheOutcome
    | undefined;
  private runtimeCacheOutcome: ConnectorRuntimeSnapshotCacheOutcome | undefined;
  private validationResult: ConnectorCatalogValidationResult | undefined;
  private catalogRawSize: number | undefined;
  private connectorCount: number | undefined;

  constructor(
    private readonly collector: ApiDispatchTimingCollector,
    private readonly requestedConnectorCount: number | undefined,
  ) {}

  recordAcceptedCacheOutcome(
    outcome: AcceptedConnectorCatalogCacheOutcome,
  ): void {
    if (
      this.acceptedCacheOutcome === undefined ||
      acceptedCacheOutcomeRank(outcome) >
        acceptedCacheOutcomeRank(this.acceptedCacheOutcome)
    ) {
      this.acceptedCacheOutcome = outcome;
    }
  }

  recordRuntimeCacheOutcome(
    outcome: ConnectorRuntimeSnapshotCacheOutcome,
  ): void {
    this.runtimeCacheOutcome = outcome;
  }

  recordValidationResult(result: ConnectorCatalogValidationResult): void {
    this.validationResult = result;
  }

  recordCatalogFacts(args: {
    readonly rawSize: number;
    readonly connectorCount: number;
  }): void {
    this.catalogRawSize = args.rawSize;
    this.connectorCount = args.connectorCount;
  }

  async measure<T>(
    actionType: ApiDispatchTimingActionType,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    return await this.collector.measure(actionType, "nested", operation);
  }

  measureSync<T>(
    actionType: ApiDispatchTimingActionType,
    operation: () => T,
  ): T {
    return this.collector.measureSync(actionType, "nested", operation);
  }

  async measureComplete<T>(operation: () => T | Promise<T>): Promise<T> {
    return await this.collector.measure(
      "api_dispatch_connector_catalog_load_runtime_snapshot",
      "nested",
      operation,
      () => {
        return this.completeDimensions();
      },
    );
  }

  private completeDimensions(): ApiDispatchTimingDimensions {
    return {
      ...(this.acceptedCacheOutcome === undefined
        ? {}
        : {
            connector_catalog_accepted_cache_outcome: this.acceptedCacheOutcome,
          }),
      ...(this.runtimeCacheOutcome === undefined
        ? {}
        : {
            connector_catalog_runtime_cache_outcome: this.runtimeCacheOutcome,
          }),
      ...(this.validationResult === undefined
        ? {}
        : {
            connector_catalog_validation_outcome: this.validationResult.outcome,
            ...(this.validationResult.outcome === "full_fallback"
              ? {
                  connector_catalog_validation_fallback_reason:
                    this.validationResult.fallbackReason,
                }
              : {}),
          }),
      ...(this.catalogRawSize === undefined
        ? {}
        : {
            connector_catalog_raw_size_bucket: rawSizeBucket(
              this.catalogRawSize,
            ),
          }),
      ...(this.connectorCount === undefined
        ? {}
        : {
            connector_catalog_connector_count_bucket: countBucket(
              this.connectorCount,
            ),
          }),
      connector_catalog_requested_connector_count_bucket:
        this.requestedConnectorCount === undefined
          ? "not_applicable"
          : countBucket(this.requestedConnectorCount),
    };
  }
}
