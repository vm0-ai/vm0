/**
 * Server-side registry of one-time purchase products.
 *
 * All fields (credit amount, expiry, source tag, allowed promo codes) are
 * sourced here — never from URL params or Stripe metadata. The `/buy` route
 * and the `checkout.session.completed` webhook both read this map, so an
 * attacker can't inflate credits by tampering with the URL or by buying an
 * unrelated Stripe product.
 */
interface OneTimeProductRule {
  credits: number;
  expiresDays: number;
  source: string;
  allowedPromoCodes: string[];
}

const ONE_TIME_PRODUCTS: Record<string, OneTimeProductRule> = {
  prod_UNJnvXagfI3NS4: {
    credits: 100_000,
    expiresDays: 30,
    source: "one_time_purchase",
    allowedPromoCodes: ["ZERO100"],
  },
};

export function getOneTimeProduct(
  productId: string,
): OneTimeProductRule | undefined {
  return ONE_TIME_PRODUCTS[productId];
}

export function isAllowedPromoCode(
  productId: string,
  promoCode: string,
): boolean {
  const rule = ONE_TIME_PRODUCTS[productId];
  return !!rule && rule.allowedPromoCodes.includes(promoCode);
}
