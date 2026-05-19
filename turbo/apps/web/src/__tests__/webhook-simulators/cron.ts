import { initServices } from "../../lib/init-services";
import { env } from "../../env";

/**
 * Cron Route Invoker
 *
 * Creates a GET request with proper CRON_SECRET authentication and calls
 * the provided route handler. Mirrors how Vercel invokes cron routes.
 *
 * @example
 *   const response = await invokeCron(GET);
 */
export async function invokeCron(
  routeHandler: (request: Request) => Promise<Response>,
): Promise<Response> {
  initServices();
  const request = new Request("http://localhost/api/cron/invoke", {
    method: "GET",
    headers: { authorization: `Bearer ${env().CRON_SECRET}` },
  });
  return routeHandler(request);
}
