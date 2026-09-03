import assert from "node:assert/strict";
import {
  createServer,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { test } from "node:test";

import { chromium } from "@playwright/test";

import { startVideoOnboardingCheckout } from "./onboarding";

interface TestServer {
  readonly origin: string;
  readonly server: Server;
}

test(
  "video onboarding recovers a deep link stalled on the app bootstrap skeleton",
  { timeout: 60_000 },
  async () => {
    let videoTemplateRequests = 0;
    const browser = await chromium.launch();
    try {
      const fixture = await listen((request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture.invalid");
        if (url.pathname === "/onboarding") {
          sendHtml(response, "<h1>What do you want to make first</h1>");
          return;
        }
        if (url.pathname === "/onboarding/video-template") {
          videoTemplateRequests += 1;
          if (videoTemplateRequests === 1) {
            sendHtml(
              response,
              '<div id="app-bootstrap-skeleton" role="status">Loading</div>',
            );
            return;
          }
          sendHtml(
            response,
            [
              "<h1>Pick a video template to start from</h1>",
              "<button aria-pressed=\"false\" onclick=\"this.setAttribute('aria-pressed', 'true')\">Video template</button>",
              "<button onclick=\"location.href='/onboarding/video-run'\">Continue</button>",
            ].join(""),
          );
          return;
        }
        if (url.pathname === "/onboarding/video-run") {
          sendHtml(
            response,
            [
              "<h1>Customize your video</h1>",
              "<button onclick=\"location.href='https://checkout.stripe.com/test-session'\">Upgrade Pro to run</button>",
            ].join(""),
          );
          return;
        }
        response.writeHead(404).end();
      });
      try {
        const page = await browser.newPage();
        try {
          await page.route("https://checkout.stripe.com/**", (route) =>
            route.fulfill({ contentType: "text/html", body: "Checkout" }),
          );

          await startVideoOnboardingCheckout(page, { appUrl: fixture.origin });

          assert.equal(videoTemplateRequests, 2);
          assert.equal(
            new URL(page.url()).origin,
            "https://checkout.stripe.com",
          );
        } finally {
          await page.close();
        }
      } finally {
        await close(fixture.server);
      }
    } finally {
      await browser.close();
    }
  },
);

async function listen(handler: RequestListener): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => reject(error);
    server.once("error", handleError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", handleError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await close(server);
    throw new Error("Fixture server did not expose a TCP address");
  }
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body>${body}</body></html>`);
}
