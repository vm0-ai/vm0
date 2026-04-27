import { serve } from "@hono/node-server";
import app from "./index";
import { logger } from "./lib/log";

const L = logger("Server");

serve(
  {
    fetch: app.fetch,
    port: 3001,
  },
  (info) => {
    L.debug(`Server is running on http://localhost:${info.port}`);
  },
);
