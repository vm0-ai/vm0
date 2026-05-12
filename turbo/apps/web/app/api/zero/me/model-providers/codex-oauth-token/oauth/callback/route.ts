import { proxyToApiBackend } from "../../../../../../../../src/lib/api-backend-proxy";

export async function GET(request: Request): Promise<Response> {
  return proxyToApiBackend(request);
}
