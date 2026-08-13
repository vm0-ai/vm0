import {
  errors,
  expect,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";

const FIELD_TIMEOUT_MS = 15_000;
const FIELD_DISCOVERY_WINDOW_MS = 500;

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

interface StripeCardMethodControl {
  readonly activation: "click" | "dispatch";
  readonly locator: Locator;
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

function visibleStripeFieldLocator(
  frame: Frame,
  field: StripeFieldDefinition,
): Locator {
  return stripeFieldLocator(frame, field).filter({ visible: true }).first();
}

function payWithCardLocator(frame: Frame): Locator {
  return frame.getByRole("button", { name: /pay with card/i });
}

async function waitForVisibleStripeField(
  page: Page,
  field: StripeFieldDefinition,
  deadline: number,
): Promise<Locator | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return null;
  }

  const timeout = Math.min(FIELD_DISCOVERY_WINDOW_MS, remaining);
  const frames = page.frames();
  const candidates = frames.map(async (frame): Promise<Locator> => {
    const locator = visibleStripeFieldLocator(frame, field);
    await locator.waitFor({ state: "attached", timeout });
    return locator;
  });

  try {
    return await Promise.any(candidates);
  } catch (error: unknown) {
    if (!(error instanceof AggregateError)) {
      throw error;
    }

    const failures: readonly unknown[] = error.errors;
    const unexpectedFailureIndex = failures.findIndex(
      (failure, index) =>
        !(failure instanceof errors.TimeoutError) &&
        !frameDetachedDuringDiscovery(page, frames[index]),
    );
    if (unexpectedFailureIndex >= 0) {
      throw failures[unexpectedFailureIndex];
    }
    return null;
  }
}

function frameDetachedDuringDiscovery(page: Page, frame: Frame): boolean {
  return !page.isClosed() && frame.isDetached();
}

async function findMatchingFrameLocator(
  page: Page,
  createLocator: (frame: Frame) => Locator,
  isMatch: (locator: Locator) => Promise<boolean>,
): Promise<Locator | null> {
  const candidates = page.frames().map((frame) => ({
    frame,
    locator: createLocator(frame),
  }));
  const matches = await Promise.all(
    candidates.map(async ({ frame, locator }): Promise<boolean> => {
      try {
        return await isMatch(locator);
      } catch (error: unknown) {
        if (frameDetachedDuringDiscovery(page, frame)) {
          return false;
        }
        throw error;
      }
    }),
  );
  return candidates.find((_, index) => matches[index])?.locator ?? null;
}

async function findPayWithCard(
  page: Page,
): Promise<StripeCardMethodControl | null> {
  const visiblePayWithCard = await findMatchingFrameLocator(
    page,
    (frame) => payWithCardLocator(frame).filter({ visible: true }).first(),
    async (locator) => await locator.isVisible(),
  );
  if (visiblePayWithCard) {
    return { activation: "click", locator: visiblePayWithCard };
  }

  const attachedPayWithCard = await findMatchingFrameLocator(
    page,
    (frame) => payWithCardLocator(frame).first(),
    async (locator) => (await locator.count()) > 0,
  );
  return attachedPayWithCard
    ? { activation: "dispatch", locator: attachedPayWithCard }
    : null;
}

async function findVisibleStripeField(
  page: Page,
  field: StripeFieldDefinition,
): Promise<Locator | null> {
  return await findMatchingFrameLocator(
    page,
    (frame) => visibleStripeFieldLocator(frame, field),
    async (locator) => (await locator.count()) > 0,
  );
}

async function fillVisibleStripeField(
  page: Page,
  field: StripeFieldDefinition,
  locator: Locator,
  value: string,
  deadline: number,
): Promise<void> {
  const timeout = deadline - Date.now();
  if (timeout <= 0) {
    throw await stripeFieldError(page, field);
  }

  try {
    await locator.fill(value, { timeout });
  } catch (error: unknown) {
    if (error instanceof errors.TimeoutError) {
      throw await stripeFieldError(page, field);
    }
    throw error;
  }
}

async function activateCardMethod(
  control: StripeCardMethodControl,
  deadline: number,
): Promise<void> {
  const timeout = deadline - Date.now();
  if (timeout <= 0) {
    return;
  }

  if (control.activation === "click") {
    await control.locator.click({ timeout });
    return;
  }

  // Stripe's accordion layout keeps the Card control attached with a
  // zero-height box. It cannot pass normal actionability checks, so this is
  // the only layout that uses synthetic activation.
  await control.locator.dispatchEvent("click", undefined, { timeout });
}

async function fillCardNumber(page: Page, value: string): Promise<void> {
  const deadline = Date.now() + FIELD_TIMEOUT_MS;
  let cardMethodActivated = false;

  while (Date.now() < deadline) {
    const visibleCardNumber = await findVisibleStripeField(
      page,
      CARD_NUMBER_FIELD,
    );
    if (visibleCardNumber) {
      await fillVisibleStripeField(
        page,
        CARD_NUMBER_FIELD,
        visibleCardNumber,
        value,
        deadline,
      );
      return;
    }

    if (!visibleCardNumber && !cardMethodActivated) {
      const payWithCard = await findPayWithCard(page);
      if (payWithCard) {
        await activateCardMethod(payWithCard, deadline);
        cardMethodActivated = true;
        continue;
      }
    }

    const discoveredCardNumber = await waitForVisibleStripeField(
      page,
      CARD_NUMBER_FIELD,
      deadline,
    );
    if (discoveredCardNumber) {
      await fillVisibleStripeField(
        page,
        CARD_NUMBER_FIELD,
        discoveredCardNumber,
        value,
        deadline,
      );
      return;
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
    const visibleField =
      (await findVisibleStripeField(page, field)) ??
      (await waitForVisibleStripeField(page, field, deadline));
    if (visibleField) {
      await fillVisibleStripeField(page, field, visibleField, value, deadline);
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
    visible: count > 0 && (await locator.filter({ visible: true }).count()) > 0,
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
