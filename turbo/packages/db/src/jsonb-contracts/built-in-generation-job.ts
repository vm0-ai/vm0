import type { JsonObject, JsonValue } from "./shared";

export interface BuiltInGenerationError {
  readonly message: string;
  readonly code: string;
}

export type BuiltInGenerationRequest = JsonObject;
export type BuiltInGenerationResult = JsonValue;
