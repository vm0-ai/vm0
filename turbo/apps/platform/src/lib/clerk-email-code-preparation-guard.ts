import type { Clerk } from "@clerk/clerk-js";

// Clerk keeps the OTP resend control disabled for 30 seconds. This shorter
// window covers automatic rerenders and route remounts without blocking a
// user-visible resend.
const AUTOMATIC_PREPARATION_WINDOW_MS = 5000;

type ClerkClient = NonNullable<Clerk["client"]>;
type SignInResource = ClerkClient["signIn"];
type SignUpResource = ClerkClient["signUp"];
type SignInPrepareParams = Parameters<SignInResource["prepareFirstFactor"]>[0];
type SignUpPrepareParams = Parameters<
  SignUpResource["prepareEmailAddressVerification"]
>[0];

interface EmailCodeVerification {
  readonly expireAt: Date | null;
  readonly nonce: string | null;
  readonly status: string | null;
  readonly strategy: string | null;
}

interface ActivePreparation {
  readonly fingerprint: string;
  readonly suppressUntil: number;
}

const guardedSignInResources = new WeakSet<SignInResource>();
const guardedSignUpResources = new WeakSet<SignUpResource>();

function activeEmailCodeFingerprint(
  verification: EmailCodeVerification,
  now: number,
): string | null {
  const expiresAt = verification.expireAt?.getTime();
  if (
    verification.status !== "unverified" ||
    verification.strategy !== "email_code" ||
    !expiresAt ||
    expiresAt <= now
  ) {
    return null;
  }

  return `${verification.nonce ?? "no-nonce"}:${expiresAt}`;
}

function createPreparationGuard<Resource, Params>(options: {
  getVerification: (resource: Resource) => EmailCodeVerification;
  key: (params: Params) => string;
  prepare: (params: Params) => Promise<Resource>;
  resource: Resource;
}): (params: Params) => Promise<Resource> {
  const activePreparations = new Map<string, ActivePreparation>();
  const pendingPreparations = new Map<string, Promise<Resource>>();

  return (params: Params): Promise<Resource> => {
    const key = options.key(params);
    const now = Date.now();
    const fingerprint = activeEmailCodeFingerprint(
      options.getVerification(options.resource),
      now,
    );
    const activePreparation = activePreparations.get(key);

    if (fingerprint && activePreparation?.fingerprint !== fingerprint) {
      activePreparations.set(key, {
        fingerprint,
        suppressUntil: now + AUTOMATIC_PREPARATION_WINDOW_MS,
      });
      return Promise.resolve(options.resource);
    }

    if (
      fingerprint &&
      activePreparation?.fingerprint === fingerprint &&
      activePreparation.suppressUntil > now
    ) {
      return Promise.resolve(options.resource);
    }

    const pendingPreparation = pendingPreparations.get(key);
    if (pendingPreparation) {
      return pendingPreparation;
    }

    const preparation = (async () => {
      try {
        const resource = await options.prepare(params);
        const preparedAt = Date.now();
        const preparedFingerprint = activeEmailCodeFingerprint(
          options.getVerification(resource),
          preparedAt,
        );
        if (preparedFingerprint) {
          activePreparations.set(key, {
            fingerprint: preparedFingerprint,
            suppressUntil: preparedAt + AUTOMATIC_PREPARATION_WINDOW_MS,
          });
        }
        return resource;
      } finally {
        pendingPreparations.delete(key);
      }
    })();

    pendingPreparations.set(key, preparation);
    return preparation;
  };
}

function guardSignUpResource(signUp: SignUpResource): void {
  if (guardedSignUpResources.has(signUp)) {
    return;
  }
  guardedSignUpResources.add(signUp);

  const originalPrepare = signUp.prepareEmailAddressVerification.bind(signUp);
  const guardedPrepare = createPreparationGuard<
    SignUpResource,
    SignUpPrepareParams
  >({
    getVerification: (resource) => {
      return resource.verifications.emailAddress;
    },
    key: () => {
      return "email_code";
    },
    prepare: originalPrepare,
    resource: signUp,
  });

  signUp.prepareEmailAddressVerification = (
    params?: SignUpPrepareParams,
  ): Promise<SignUpResource> => {
    if (params?.strategy && params.strategy !== "email_code") {
      return originalPrepare(params);
    }
    return guardedPrepare(params);
  };
}

function guardSignInResource(signIn: SignInResource): void {
  if (guardedSignInResources.has(signIn)) {
    return;
  }
  guardedSignInResources.add(signIn);

  const originalPrepare = signIn.prepareFirstFactor.bind(signIn);
  const guardedPrepare = createPreparationGuard<
    SignInResource,
    SignInPrepareParams
  >({
    getVerification: (resource) => {
      return resource.firstFactorVerification;
    },
    key: (params) => {
      if (params.strategy === "email_code") {
        return `${params.strategy}:${params.emailAddressId}`;
      }
      return params.strategy;
    },
    prepare: originalPrepare,
    resource: signIn,
  });

  signIn.prepareFirstFactor = (
    params: SignInPrepareParams,
  ): Promise<SignInResource> => {
    if (params.strategy !== "email_code") {
      return originalPrepare(params);
    }
    return guardedPrepare(params);
  };
}

/**
 * Clerk's prebuilt email-code screens can prepare a second code immediately
 * after the current code was created. Keep this compatibility guard until the
 * upstream sign-up and sign-in fixes are verified in vm0:
 * https://github.com/clerk/javascript/issues/8684
 * https://github.com/clerk/javascript/issues/4324
 */
export function installClerkEmailCodePreparationGuard(clerk: Clerk): void {
  const guardCurrentResources = (): void => {
    if (!clerk.client) {
      return;
    }
    guardSignUpResource(clerk.client.signUp);
    guardSignInResource(clerk.client.signIn);
  };

  guardCurrentResources();
  clerk.addListener(guardCurrentResources);
}
