import "./instrument";
import { createApp } from "./app-factory";

const app = (() => {
  const instanceAbortController = new AbortController();

  process.once("SIGTERM", () => {
    const error = new Error("Aborted due to terminated function instance");
    error.name = "AbortError";
    instanceAbortController.abort(error);
  });

  return createApp({ signal: instanceAbortController.signal });
})();

export default app;
