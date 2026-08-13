import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium, type Page } from "@playwright/test";

import {
  collectStripeCheckoutState,
  fillStripeCheckout,
} from "./stripe-checkout";

type CheckoutLayout = "accordion" | "expanded" | "iframe" | "wallet";

const CARD_FIELDS = `
  <label>Card number <input name="cardNumber" placeholder="1234 1234 1234 1234"></label>
  <label>Expiration <input name="cardExpiry" placeholder="MM / YY"></label>
  <label>Security code <input name="cardCvc" placeholder="CVC"></label>
`;

test("fills and submits every supported Stripe Checkout card layout", async (context) => {
  const browser = await chromium.launch();
  try {
    for (const layout of [
      "expanded",
      "iframe",
      "wallet",
      "accordion",
    ] as const) {
      await context.test(layout, async () => {
        const page = await browser.newPage();
        try {
          await openCheckoutFixture(page, layout);
          const state = await collectStripeCheckoutState(page);
          assert.equal(state.pageOrigin, "https://checkout.stripe.com");
          assert.equal(state.title, "Checkout fixture");
          assert.doesNotMatch(JSON.stringify(state), /\/c\/pay\//u);

          await fillStripeCheckout(page);

          await assertCheckoutWasSubmitted(page);
        } finally {
          await page.close();
        }
      });
    }
  } finally {
    await browser.close();
  }
});

async function openCheckoutFixture(
  page: Page,
  layout: CheckoutLayout,
): Promise<void> {
  await page.route("https://checkout.stripe.com/**", async (route) => {
    await route.fulfill({
      body: checkoutDocument(layout),
      contentType: "text/html",
      status: 200,
    });
  });
  await page.goto(`https://checkout.stripe.com/c/pay/${layout}`);
}

function checkoutDocument(layout: CheckoutLayout): string {
  const cardControl =
    layout === "expanded" || layout === "iframe"
      ? ""
      : `<button id="pay-with-card" type="button"${
          layout === "accordion"
            ? ' style="height: 0; overflow: hidden; position: absolute; width: 0"'
            : ""
        }>Pay with card</button>`;

  return `<!doctype html>
<html>
  <head><title>Checkout fixture</title></head>
  <body data-layout="${layout}">
    <label>Email <input name="email"></label>
    <label><input aria-label="Save my information" type="checkbox" checked> Save my information</label>
    <label>Cardholder name <input name="billingName"></label>
    <label>Postal code <input name="billingPostalCode"></label>
    ${cardControl}
    <div id="card-host"></div>
    <button id="submit" type="button">Subscribe</button>
    <script>
      const cardFields = ${JSON.stringify(CARD_FIELDS)};
      const host = document.querySelector("#card-host");
      const renderCardForm = () => {
        host.innerHTML = cardFields;
      };
      if (document.body.dataset.layout === "expanded") {
        renderCardForm();
      } else if (document.body.dataset.layout === "iframe") {
        const frame = document.createElement("iframe");
        frame.srcdoc = ${JSON.stringify(
          `<!doctype html><html><body>${CARD_FIELDS}</body></html>`,
        )};
        host.append(frame);
      } else {
        document.querySelector("#pay-with-card").addEventListener("click", (event) => {
          if (document.body.dataset.layout === "wallet" && !event.isTrusted) {
            return;
          }
          if (document.body.dataset.layout === "wallet") {
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(renderCardForm);
            });
          } else {
            renderCardForm();
          }
        }, { once: true });
      }
      document.querySelector("#submit").addEventListener("click", () => {
        document.body.dataset.submitted = "true";
      });
    </script>
  </body>
</html>`;
}

async function assertCheckoutWasSubmitted(page: Page): Promise<void> {
  assert.equal(await stripeFieldValue(page, "cardNumber"), "4242424242424242");
  assert.equal(await stripeFieldValue(page, "cardExpiry"), "1234");
  assert.equal(await stripeFieldValue(page, "cardCvc"), "123");
  assert.equal(
    await page.locator('input[name="billingName"]').inputValue(),
    "VM0 Billing E2E",
  );
  assert.equal(
    await page.locator('input[name="billingPostalCode"]').inputValue(),
    "94107",
  );
  assert.match(
    await page.locator('input[name="email"]').inputValue(),
    /^billing-e2e-\d+@vm0-e2e\.ai$/u,
  );
  assert.equal(
    await page
      .getByRole("checkbox", { name: /save my information/i })
      .isChecked(),
    false,
  );
  assert.equal(
    await page.locator("body").getAttribute("data-submitted"),
    "true",
  );
}

async function stripeFieldValue(page: Page, name: string): Promise<string> {
  for (const frame of page.frames()) {
    const field = frame.locator(`input[name="${name}"]`);
    if ((await field.count()) > 0) {
      return await field.inputValue();
    }
  }
  throw new Error(`Missing Stripe fixture field ${name}`);
}
