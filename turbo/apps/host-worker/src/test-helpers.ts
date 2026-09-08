import worker from "./index";

/** Own Cloudflare background cache work through the response's test lifetime. */
export async function fetchWorker(
  request: Request,
  env: Parameters<typeof worker.fetch>[1],
): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(request, env, {
    waitUntil(promise) {
      pending.push(promise);
    },
  });
  await Promise.all(pending);
  return response;
}
