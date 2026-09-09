import { z } from "zod";
import type { Socket } from "node:net";

export const CUA_REQUEST_BYTES = 1_000_000;
export const CUA_REPLY_BYTES = 24_000_000;
export const CUA_MAX_PENDING = 8;
export const cuaMonotonicMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const text = z.string().max(64_000);
const pid = z.number().int().positive();
const session = z
  .string()
  .regex(/^okou-(command|host-probe)-[a-zA-Z0-9-]+$/)
  .max(200);
const delivery = z.enum(["foreground", "background"]);
const target = {
  pid,
  window_id: pid,
  session,
  element_token: text.optional(),
  snapshot_id: text.nullable().optional(),
};
export const cuaToolSchema = z.discriminatedUnion("name", [
  z
    .object({
      name: z.literal("check_permissions"),
      args: z
        .object({
          prompt: z.literal(false),
          probe_direct_capture: z.literal(false),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ name: z.literal("list_apps"), args: z.object({}).strict() })
    .strict(),
  z
    .object({
      name: z.literal("launch_app"),
      args: z.object({ bundle_id: text.min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("list_windows"),
      args: z.object({ pid, on_screen_only: z.literal(true) }).strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("get_window_state"),
      args: z
        .object({
          ...target,
          include_screenshot: z.literal(true),
          max_elements: z.literal(1200),
          max_depth: z.literal(32),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("click"),
      args: z
        .object({
          ...target,
          button: z.enum(["left", "right", "middle"]).optional(),
          action: z
            .enum(["press", "confirm", "show_menu", "pick", "cancel", "open"])
            .optional(),
          x: z.number().finite().nonnegative().optional(),
          y: z.number().finite().nonnegative().optional(),
          count: z.number().int().min(1).max(3).optional(),
          scope: z.literal("window").optional(),
          delivery_mode: delivery,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("set_value"),
      args: z.object({ ...target, value: text }).strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("type_text"),
      args: z
        .object({
          ...target,
          text,
          delay_ms: z.literal(0),
          delivery_mode: delivery,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("press_key"),
      args: z
        .object({
          ...target,
          key: text,
          modifiers: z.array(text).max(8),
          delivery_mode: delivery,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("scroll"),
      args: z
        .object({
          ...target,
          direction: z.enum(["up", "down", "left", "right"]),
          by: z.literal("page"),
          amount: z.number().finite().positive(),
          delivery_mode: z.literal("background"),
        })
        .strict(),
    })
    .strict(),
]);
const empty = z.object({}).strict();
export const cuaOperationSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("start"), input: empty }).strict(),
  z.object({ method: z.literal("stop"), input: empty }).strict(),
  z.object({ method: z.literal("metadata"), input: empty }).strict(),
  z.object({ method: z.literal("destroyClient"), input: empty }).strict(),
  z.object({ method: z.literal("destroyHost"), input: empty }).strict(),
  z.object({ method: z.literal("finish"), input: empty }).strict(),
  z
    .object({
      method: z.literal("exit"),
      input: z.object({ generation: text }).strict(),
    })
    .strict(),
  z.object({ method: z.literal("tool"), input: cuaToolSchema }).strict(),
  z
    .object({
      method: z.literal("sessionStart"),
      input: z.object({ session }).strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("sessionEnd"),
      input: z.object({ session }).strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("desktopState"),
      input: z.object({ session }).strict(),
    })
    .strict(),
]);
export const cuaRequestSchema = z
  .object({
    generation: pid,
    id: pid,
    expiresAt: z.number().finite().positive(),
    operation: cuaOperationSchema,
  })
  .strict();
export const cuaCancelSchema = z
  .object({ generation: pid, cancel: pid })
  .strict();
export const cuaReplySchema = z.discriminatedUnion("ok", [
  z
    .object({
      generation: pid,
      id: pid,
      ok: z.literal(true),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      generation: pid,
      id: pid,
      ok: z.literal(false),
      error: z.literal("cua_operation_failed"),
    })
    .strict(),
]);
export type CuaOperation = z.infer<typeof cuaOperationSchema>;
export const cuaExitSchema = z
  .object({
    generation: text,
    code: z.number().int().optional(),
    success: z.boolean(),
  })
  .strict();
export const cuaConnectionSchema = z
  .object({
    socketPath: text,
    pid,
    generation: text,
    driverVersion: text,
    contractVersion: text,
    mcpProtocolVersion: text,
    mcp: z
      .object({
        command: z.literal(""),
        args: z.array(z.never()).max(0),
        environment: z.array(z.never()).max(0),
      })
      .strict(),
  })
  .strict();
export const cuaMetadataSchema = z
  .object({
    driverVersion: text,
    contractVersion: text,
    toolsListSchemaVersion: text,
    capabilityVersion: text,
    mcpProtocolVersion: text,
    pid,
    embedded: z.boolean(),
    hostBundleId: text.optional(),
  })
  .strict();
export const cuaToolResultSchema = z.object({
  text: z.string().max(CUA_REPLY_BYTES),
  images: z
    .array(
      z
        .object({ mimeType: text, dataBase64: z.string().max(8_000_000) })
        .strict(),
    )
    .max(8),
  structuredJson: z.string().max(CUA_REPLY_BYTES).optional(),
  isError: z.boolean(),
  degraded: z.boolean(),
  rawJson: z.string().max(CUA_REPLY_BYTES),
  errorCode: text.optional(),
});
export const cuaSessionStartSchema = z.object({
  active: z.boolean(),
  revived: z.boolean(),
  state: z.object({
    session: text,
    captureScope: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    effectiveScope: z.union([z.literal(0), z.literal(1)]),
    desktopCaptureAuthorized: z.boolean(),
    desktopUnlocked: z.boolean(),
  }),
});
export const cuaSessionEndSchema = z
  .object({ session: text, active: z.boolean() })
  .strict();

/** Linear buffering with a byte cap before JSON parsing, including split UTF-8. */
export function readCuaFrames(
  socket: Socket,
  limit: number,
  accept: (value: unknown) => void,
  fail: () => void,
): void {
  let failed = false;
  const reject = () => {
    failed = true;
    chunks = [];
    fail();
  };
  let chunks: Buffer[] = [];
  let bytes = 0;
  socket.on("data", (chunk: Buffer) => {
    if (failed) return;
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      bytes += part.length;
      if (bytes > limit) {
        reject();
        return;
      }
      chunks.push(part);
      if (end < 0) return;
      const frame = Buffer.concat(chunks, bytes).toString("utf8");
      chunks = [];
      bytes = 0;
      try {
        accept(JSON.parse(frame));
      } catch {
        reject();
        return;
      }
      start = end + 1;
    }
  });
}
