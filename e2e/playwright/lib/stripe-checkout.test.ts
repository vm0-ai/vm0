import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium, type Page } from "@playwright/test";

import {
  collectStripeCheckoutState,
  fillStripeCheckout,
} from "./stripe-checkout";

type CheckoutLayout =
  | "accordion"
  | "expanded"
  | "framed-accordion"
  | "hidden-duplicates"
  | "iframe"
  | "late-frame"
  | "replaced-field-frame"
  | "wallet";

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
      "hidden-duplicates",
      "late-frame",
      "replaced-field-frame",
      "wallet",
      "accordion",
      "framed-accordion",
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
          if (layout === "framed-accordion") {
            const cardFrame = page.frame({ name: "stripe-card" });
            assert.ok(cardFrame, "expected the Stripe card frame to remain");
            assert.equal(
              await cardFrame
                .locator("body")
                .getAttribute("data-activation-count"),
              "1",
            );
          }
          if (
            layout === "hidden-duplicates" ||
            layout === "replaced-field-frame"
          ) {
            assert.equal(
              await page.locator("body").getAttribute("data-activation-count"),
              "1",
            );
          }
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
    layout === "expanded" ||
    layout === "framed-accordion" ||
    layout === "iframe" ||
    layout === "late-frame" ||
    layout === "replaced-field-frame"
      ? ""
      : layout === "hidden-duplicates"
        ? `<button type="button" style="border: 0; height: 0; overflow: hidden; padding: 0; position: absolute; width: 0">Pay with card</button>
           <button id="pay-with-card" type="button">Pay with card</button>`
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
        host.innerHTML = document.body.dataset.layout === "hidden-duplicates"
          ? "<div hidden>" + cardFields + "</div>" + cardFields
          : cardFields;
      };
      if (document.body.dataset.layout === "hidden-duplicates") {
        document.body.dataset.activationCount = "0";
      }
      if (document.body.dataset.layout === "expanded") {
        renderCardForm();
      } else if (document.body.dataset.layout === "iframe") {
        const frame = document.createElement("iframe");
        frame.srcdoc = ${JSON.stringify(
          `<!doctype html><html><body>${CARD_FIELDS}</body></html>`,
        )};
        host.append(frame);
      } else if (document.body.dataset.layout === "late-frame") {
        const unrelatedFrames = [];
        for (let index = 0; index < 32; index += 1) {
          const unrelatedFrame = document.createElement("iframe");
          unrelatedFrame.title = \`Unrelated frame \${index}\`;
          host.append(unrelatedFrame);
          unrelatedFrames.push(unrelatedFrame);
        }

        const cardFrame = document.createElement("iframe");
        cardFrame.title = "Late card frame";
        cardFrame.srcdoc = '<button id="pay-with-card" type="button">Pay with card</button><div id="card-host"></div>';
        cardFrame.addEventListener("load", () => {
          const cardDocument = cardFrame.contentDocument;
          const cardHost = cardDocument.querySelector("#card-host");
          cardDocument.querySelector("#pay-with-card").addEventListener("click", (event) => {
            if (!event.isTrusted) {
              return;
            }
            window.requestAnimationFrame(() => {
              for (const unrelatedFrame of unrelatedFrames) {
                unrelatedFrame.remove();
              }
              window.requestAnimationFrame(() => {
                const fieldsFrame = cardDocument.createElement("iframe");
                fieldsFrame.srcdoc = cardFields;
                cardHost.append(fieldsFrame);
              });
            });
          }, { once: true });
        });
        host.append(cardFrame);
      } else if (document.body.dataset.layout === "replaced-field-frame") {
        document.body.dataset.activationCount = "0";
        const payWithCard = document.createElement("button");
        payWithCard.type = "button";
        payWithCard.textContent = "Pay with card";
        const initialFieldsFrame = document.createElement("iframe");
        initialFieldsFrame.title = "Initial hidden card fields";
        initialFieldsFrame.srcdoc = ${JSON.stringify(
          `<div hidden>${CARD_FIELDS}</div>`,
        )};
        payWithCard.addEventListener("click", () => {
          document.body.dataset.activationCount = String(
            Number(document.body.dataset.activationCount) + 1
          );
          initialFieldsFrame.remove();
          window.requestAnimationFrame(() => {
            const replacementFieldsFrame = document.createElement("iframe");
            replacementFieldsFrame.title = "Replacement card fields";
            replacementFieldsFrame.srcdoc = cardFields;
            host.append(replacementFieldsFrame);
          });
        }, { once: true });
        host.append(payWithCard, initialFieldsFrame);
      } else if (document.body.dataset.layout === "framed-accordion") {
        for (let index = 0; index < 32; index += 1) {
          const unrelatedFrame = document.createElement("iframe");
          unrelatedFrame.title = "unrelated-frame-" + index;
          unrelatedFrame.srcdoc = "<p>Unrelated frame " + index + "</p>";
          host.append(unrelatedFrame);
        }
        const cardFrame = document.createElement("iframe");
        cardFrame.name = "stripe-card";
        cardFrame.title = "Stripe card entry";
        cardFrame.srcdoc = ${JSON.stringify(framedAccordionDocument())};
        host.append(cardFrame);
      } else {
        document.querySelector("#pay-with-card").addEventListener("click", (event) => {
          if (
            (document.body.dataset.layout === "wallet" ||
              document.body.dataset.layout === "hidden-duplicates") &&
            !event.isTrusted
          ) {
            return;
          }
          if (document.body.dataset.layout === "hidden-duplicates") {
            document.body.dataset.activationCount = String(
              Number(document.body.dataset.activationCount) + 1
            );
            renderCardForm();
          } else if (document.body.dataset.layout === "wallet") {
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

function framedAccordionDocument(): string {
  return `<!doctype html>
<html>
  <body data-activation-count="0">
    <button
      type="button"
      style="height: 0; overflow: hidden; padding: 0; border: 0"
      onclick="
        document.body.dataset.activationCount = String(
          Number(document.body.dataset.activationCount) + 1
        );
        document.querySelector('#card-fields').hidden = false;
      "
    >Pay with card</button>
    <div id="card-fields" hidden>${CARD_FIELDS}</div>
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
    const field = frame
      .locator(`input[name="${name}"]`)
      .filter({ visible: true })
      .first();
    if ((await field.count()) > 0) {
      return await field.inputValue();
    }
  }
  throw new Error(`Missing Stripe fixture field ${name}`);
}
