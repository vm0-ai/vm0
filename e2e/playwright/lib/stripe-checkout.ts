import {
  errors,
  expect,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";

const FIELD_TIMEOUT_MS = 15_000;
const LOCATOR_ATTEMPT_TIMEOUT_MS = 500;

interface StripeFieldDefinition {
  readonly label: RegExp;
  readonly name: string;
  readonly placeholder: RegExp;
}

interface StripeLocatorState {
  readonly count: number;
  readonly visible: boolean;
}

interface StripeFrameState {
  readonly cardCvc: StripeLocatorState;
  readonly cardExpiry: StripeLocatorState;
  readonly cardNumber: StripeLocatorState;
  readonly main: boolean;
  readonly origin: string;
  readonly payWithCard: StripeLocatorState;
}

export interface StripeCheckoutState {
  readonly frames: readonly StripeFrameState[];
  readonly pageOrigin: string;
  readonly title: string;
}

const CARD_NUMBER_FIELD: StripeFieldDefinition = {
  label: /card number/i,
  name: "cardNumber",
  placeholder: /1234 1234 1234 1234/i,
};

const CARD_EXPIRY_FIELD: StripeFieldDefinition = {
  label: /expiration|expiry/i,
  name: "cardExpiry",
  placeholder: /MM\s*\/\s*YY/i,
};

const CARD_CVC_FIELD: StripeFieldDefinition = {
  label: /security code|cvc/i,
  name: "cardCvc",
  placeholder: /CVC/i,
};

async function fillFirst(
  locator: Locator,
  value: string,
  timeout = 5_000,
): Promise<boolean> {
  try {
    await locator.first().fill(value, { timeout });
    return true;
  } catch (error: unknown) {
    if (error instanceof errors.TimeoutError) {
      return false;
    }
    throw error;
  }
}

function stripeFieldLocator(
  frame: Frame,
  field: StripeFieldDefinition,
): Locator {
  return frame
    .getByLabel(field.label)
    .or(frame.getByPlaceholder(field.placeholder))
    .or(frame.locator(`input[name="${field.name}"]`));
}

function payWithCardLocator(frame: Frame): Locator {
  return frame.getByRole("button", { name: /pay with card/i });
}

async function tryFillStripeField(
  page: Page,
  field: StripeFieldDefinition,
  value: string,
  deadline: number,
): Promise<boolean> {
  for (const frame of page.frames()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    if (
      await fillFirst(
        stripeFieldLocator(frame, field),
        value,
        Math.min(LOCATOR_ATTEMPT_TIMEOUT_MS, remaining),
      )
    ) {
      return true;
    }
  }
  return false;
}

async function findPayWithCard(page: Page): Promise<Locator | null> {
  for (const frame of page.frames()) {
    const locator = payWithCardLocator(frame);
    if ((await locator.count()) > 0) {
      return locator.first();
    }
  }
  return null;
}

async function activateCardMethod(
  payWithCard: Locator,
  deadline: number,
): Promise<void> {
  const timeout = deadline - Date.now();
  if (timeout <= 0) {
    return;
  }

  if (await payWithCard.isVisible()) {
    await payWithCard.click({ timeout });
    return;
  }

  // Stripe's accordion layout keeps the Card control attached with a
  // zero-height box. It cannot pass normal actionability checks, so this is
  // the only layout that uses synthetic activation.
  await payWithCard.dispatchEvent("click", undefined, { timeout });
}

async function fillCardNumber(page: Page, value: string): Promise<void> {
  const deadline = Date.now() + FIELD_TIMEOUT_MS;
  let cardMethodActivated = false;

  while (Date.now() < deadline) {
    if (await tryFillStripeField(page, CARD_NUMBER_FIELD, value, deadline)) {
      return;
    }

    if (!cardMethodActivated) {
      const payWithCard = await findPayWithCard(page);
      if (payWithCard) {
        await activateCardMethod(payWithCard, deadline);
        cardMethodActivated = true;
      }
    }
  }

  throw await stripeFieldError(page, CARD_NUMBER_FIELD);
}

async function fillStripeField(
  page: Page,
  field: StripeFieldDefinition,
  value: string,
): Promise<void> {
  const deadline = Date.now() + FIELD_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await tryFillStripeField(page, field, value, deadline)) {
      return;
    }
  }

  throw await stripeFieldError(page, field);
}

async function stripeFieldError(
  page: Page,
  field: StripeFieldDefinition,
): Promise<Error> {
  const state = await collectStripeCheckoutState(page).catch(() => null);
  return new Error(
    `Unable to fill Stripe field ${field.name}; state=${state ? JSON.stringify(state) : "unavailable"}`,
  );
}

async function locatorState(locator: Locator): Promise<StripeLocatorState> {
  const count = await locator.count();
  return {
    count,
    visible: count > 0 && (await locator.first().isVisible()),
  };
}

function sanitizedOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "unavailable";
  }
}

export async function collectStripeCheckoutState(
  page: Page,
): Promise<StripeCheckoutState> {
  const mainFrame = page.mainFrame();
  const frames = await Promise.all(
    page.frames().map(async (frame): Promise<StripeFrameState> => {
      const [cardNumber, cardExpiry, cardCvc, payWithCard] = await Promise.all([
        locatorState(stripeFieldLocator(frame, CARD_NUMBER_FIELD)),
        locatorState(stripeFieldLocator(frame, CARD_EXPIRY_FIELD)),
        locatorState(stripeFieldLocator(frame, CARD_CVC_FIELD)),
        locatorState(payWithCardLocator(frame)),
      ]);
      return {
        cardCvc,
        cardExpiry,
        cardNumber,
        main: frame === mainFrame,
        origin: sanitizedOrigin(frame.url()),
        payWithCard,
      };
    }),
  );

  return {
    frames,
    pageOrigin: sanitizedOrigin(page.url()),
    title: await page.title(),
  };
}

async function disableLinkSaveInfo(page: Page): Promise<void> {
  const saveInfo = page.getByRole("checkbox", {
    name: /save my information/i,
  });

  if (await saveInfo.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await saveInfo.uncheck();
  }
}

export async function fillStripeCheckout(page: Page): Promise<void> {
  await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 30_000 });

  await fillFirst(
    page.getByLabel(/email/i).or(page.locator('input[name="email"]')),
    `billing-e2e-${Date.now()}@vm0-e2e.ai`,
  );
  await disableLinkSaveInfo(page);

  await fillCardNumber(page, "4242424242424242");
  await fillStripeField(page, CARD_EXPIRY_FIELD, "1234");
  await fillStripeField(page, CARD_CVC_FIELD, "123");
  await fillFirst(
    page
      .getByLabel(/cardholder name|name on card/i)
      .or(page.locator('input[name="billingName"]')),
    "VM0 Billing E2E",
  );
  await fillFirst(
    page
      .getByLabel(/zip|postal/i)
      .or(page.locator('input[name="billingPostalCode"]')),
    "94107",
  );

  await page
    .getByRole("button", { name: /^(subscribe|start trial)$/i })
    .click({ timeout: 30_000 });
}
