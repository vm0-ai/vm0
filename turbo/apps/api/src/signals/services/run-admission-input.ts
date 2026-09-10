/** Captured old inputs must never fall through to a supported launch variant. */
export function isUnsupportedRunAdmission(
  triggerSource: string | undefined,
  association: { readonly kind: string } | undefined,
): boolean {
  return (
    triggerSource === "goal" ||
    (association !== undefined &&
      association.kind !== "user_message" &&
      association.kind !== "automation_event")
  );
}
