import { proxyToApiBackend } from "../../../../../src/lib/api-backend-proxy";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return proxyToApiBackend(request);
}
