export type PiApiFirstTurnOwnershipStage =
  | "pre-provider"
  | "provider-may-have-started";

export interface PiApiFirstTurnOwnership {
  readonly stage: PiApiFirstTurnOwnershipStage;
  markProviderRequestMayHaveStarted(): void;
}

/** Track the irreversible provider-request ownership boundary for one turn. */
export function createPiApiFirstTurnOwnership(): PiApiFirstTurnOwnership {
  let stage: PiApiFirstTurnOwnershipStage = "pre-provider";
  return {
    get stage() {
      return stage;
    },
    markProviderRequestMayHaveStarted() {
      stage = "provider-may-have-started";
    },
  };
}
