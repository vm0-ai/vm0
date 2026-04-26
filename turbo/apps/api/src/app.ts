import { httpInstrumentationMiddleware } from "@hono/otel";
import { Hono } from "hono";

import {
  flushTelemetrySafely,
  telemetryServiceName,
  telemetryServiceVersion,
} from "./lib/observability";
import { listBuiltInModels } from "./services/vm0-models";

const app = new Hono();

app.use("*", async (_c, next) => {
  try {
    await next();
  } finally {
    await flushTelemetrySafely();
  }
});

app.use(
  "*",
  httpInstrumentationMiddleware({
    serviceName: telemetryServiceName,
    serviceVersion: telemetryServiceVersion,
  }),
);

app.get("/", async (c) => {
  const models = await listBuiltInModels();
  return c.json({ message: "Hello Hono!", models });
});

export default app;
