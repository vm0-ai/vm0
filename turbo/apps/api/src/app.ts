import "./instrument";
import { createApp } from "./app-factory";

const instanceAbortController = new AbortController();

process.once("SIGTERM", () => {
  const error = new Error("Aborted due to terminated function instance");
  error.name = "AbortError";
  instanceAbortController.abort(error);
});

const instanceSignal = instanceAbortController.signal;

const app = createApp(instanceSignal);
export default app;
