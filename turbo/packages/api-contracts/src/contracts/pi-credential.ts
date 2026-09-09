import { z } from "zod";

export const piCredentialHeaderSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z][A-Za-z0-9-]*$/),
    valueTemplate: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => {
        const staticTemplate = value.replace("{{secret}}", "");
        return (
          !value.includes("\r") &&
          !value.includes("\n") &&
          value.split("{{secret}}").length === 2 &&
          !staticTemplate.includes("{{") &&
          !staticTemplate.includes("}}")
        );
      }, "Credential header template must contain {{secret}} exactly once, no other template references, and no line breaks"),
  })
  .strict()
  .readonly();
