export type PiGptModel = "gpt-5.6-terra" | "gpt-5.6-sol" | "gpt-5.6-luna";

/** Pi admission and API-owned billing must expand together. */
export function isPiGptModel(
  model: string | null | undefined,
): model is PiGptModel {
  return (
    model === "gpt-5.6-terra" ||
    model === "gpt-5.6-sol" ||
    model === "gpt-5.6-luna"
  );
}
