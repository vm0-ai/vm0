/** Clerk-owned evidence. Readers must validate values before using them. */
export interface ImportedFirstTouch {
  readonly present: boolean;
  readonly value: unknown;
  readonly privacyReceipt: unknown;
}

export interface ImportedDelivery {
  readonly value: unknown;
}

export interface ImportedAttributionSnapshot {
  readonly firstTouch: ImportedFirstTouch;
  readonly deliveries: Record<string, unknown>;
  readonly invalidDeliveryMap?: ImportedDelivery;
}
