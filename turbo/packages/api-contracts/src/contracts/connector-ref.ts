import { z } from "zod";

export const CONNECTOR_REF_MAX_LENGTH = 64;

export const connectorRefSchema = z
  .string()
  .min(1)
  .max(CONNECTOR_REF_MAX_LENGTH);
