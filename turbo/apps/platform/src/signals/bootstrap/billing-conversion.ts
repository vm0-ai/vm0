const BILLING_CONVERSION_VALUE = {
  pro: 20,
  team: 200,
} as const;

export function googleAdsBillingConversionPayload(
  billing: string | null,
  transactionId: string | null,
): {
  readonly send_to: "AW-18144854014/3tdOCMimwK8cEP7_kcxD";
  readonly value: number;
  readonly currency: "USD";
  readonly transaction_id?: string;
} | null {
  if (billing !== "pro" && billing !== "team") {
    return null;
  }

  return {
    send_to: "AW-18144854014/3tdOCMimwK8cEP7_kcxD",
    value: BILLING_CONVERSION_VALUE[billing],
    currency: "USD",
    ...(transactionId ? { transaction_id: transactionId } : {}),
  };
}
