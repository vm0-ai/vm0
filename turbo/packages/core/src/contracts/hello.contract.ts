import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const HelloRequestSchema = z.object({
  name: z.string().min(1).describe("Your name"),
  language: z
    .enum(["en", "es", "fr", "de"])
    .optional()
    .default("en")
    .describe("Preferred language for greeting"),
  includeTime: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include current time in response"),
});

export const HelloResponseSchema = z.object({
  message: z.string().describe("Personalized greeting message"),
  timestamp: z
    .string()
    .datetime()
    .describe("ISO 8601 timestamp of the response"),
  locale: z.string().describe("Language locale used for the greeting"),
  metadata: z
    .object({
      requestId: z.string().uuid().describe("Unique request identifier"),
      version: z.string().describe("API version"),
      serverTime: z.string().optional().describe("Server time if requested"),
    })
    .describe("Additional response metadata"),
});

export type HelloRequest = z.infer<typeof HelloRequestSchema>;
export type HelloResponse = z.infer<typeof HelloResponseSchema>;

export const helloContract = c.router({
  sayHello: {
    method: "POST",
    path: "/api/hello",
    body: HelloRequestSchema,
    responses: {
      200: HelloResponseSchema,
      400: z.object({
        error: z.string(),
        details: z
          .array(
            z.object({
              field: z.string(),
              message: z.string(),
            }),
          )
          .optional(),
      }),
    },
    summary: "Generate a personalized greeting",
    description:
      "Creates a personalized greeting message based on the provided name and language preference",
  },

  getGreeting: {
    method: "GET",
    path: "/api/hello/:name",
    pathParams: z.object({
      name: z.string().describe("Name to greet"),
    }),
    query: z.object({
      lang: z
        .enum(["en", "es", "fr", "de"])
        .optional()
        .describe("Language for greeting"),
    }),
    responses: {
      200: z.object({
        greeting: z.string(),
        name: z.string(),
        language: z.string(),
      }),
    },
    summary: "Simple GET greeting",
    description: "A simpler GET endpoint for quick greetings",
  },
});
