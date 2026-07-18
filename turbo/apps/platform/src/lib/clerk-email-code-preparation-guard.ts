import type { Clerk } from "@clerk/clerk-js";

import { now } from "./time.ts";

// Clerk keeps the OTP resend control disabled for 30 seconds. This shorter
// window covers automatic rerenders and route remounts without blocking a
// user-visible resend.
const AUTOMATIC_PREPARATION_WINDOW_MS = 5000;

type ClerkClient = NonNullable<Clerk["client"]>;
type SignInResource = ClerkClient["signIn"];
type SignUpResource = ClerkClient["signUp"];
type SignInPrepareParams = Parameters<SignInResource["prepareFirstFactor"]>[0];
type SignUpCreateParams = Parameters<SignUpResource["create"]>[0];
type SignUpPrepareParams = Parameters<
  SignUpResource["prepareEmailAddressVerification"]
>[0];

const SIGN_UP_EMAIL_CODE_KEY = "email_code";

interface EmailCodeVerification {
  readonly expireAt: Date | null;
  readonly nonce: string | null;
  readonly status: string | null;
  readonly strategy: string | null;
}

interface ActivePreparation {
  readonly fingerprint: string | null;
  readonly suppressUntil: number;
}

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

function signUpCreateSendsEmailCode(params: SignUpCreateParams): boolean {
  return (
    typeof params.emailAddress === "string" &&
    params.emailAddress.length > 0 &&
    params.strategy === undefined &&
    params.externalAccountStrategy === undefined
  );
}

function createPreparationGuard<Resource, Params>(options: {
  activePreparations: Map<string, ActivePreparation>;
  getVerification: (resource: Resource) => EmailCodeVerification;
  key: (params: Params) => string;
  prepare: (params: Params) => Promise<Resource>;
  resource: Resource;
}): (params: Params) => Promise<Resource> {
  const pendingPreparations = new Map<string, Promise<Resource>>();

  return (params: Params): Promise<Resource> => {
    const key = options.key(params);
    const currentTime = now();
    const fingerprint = activeEmailCodeFingerprint(
      options.getVerification(options.resource),
      currentTime,
    );
    let activePreparation = options.activePreparations.get(key);

    if (fingerprint && activePreparation?.fingerprint === null) {
      activePreparation = { ...activePreparation, fingerprint };
      options.activePreparations.set(key, activePreparation);
    }

    if (
      activePreparation &&
      activePreparation.suppressUntil > currentTime &&
      (fingerprint === null || activePreparation.fingerprint === fingerprint)
    ) {
      return Promise.resolve(options.resource);
    }

    if (fingerprint && activePreparation?.fingerprint !== fingerprint) {
      const knownForAnotherFactor = Array.from(
        options.activePreparations.entries(),
      ).some(([activeKey, preparation]) => {
        return activeKey !== key && preparation.fingerprint === fingerprint;
      });
      if (!knownForAnotherFactor) {
        options.activePreparations.set(key, {
          fingerprint,
          suppressUntil: currentTime + AUTOMATIC_PREPARATION_WINDOW_MS,
        });
        return Promise.resolve(options.resource);
      }
    }

    const pendingPreparation = pendingPreparations.get(key);
    if (pendingPreparation) {
      return pendingPreparation;
    }

    const preparation = (async () => {
      const resource = await options.prepare(params).finally(() => {
        pendingPreparations.delete(key);
      });
      const preparedAt = now();
      const preparedFingerprint = activeEmailCodeFingerprint(
        options.getVerification(resource),
        preparedAt,
      );
      options.activePreparations.set(key, {
        fingerprint: preparedFingerprint,
        suppressUntil: preparedAt + AUTOMATIC_PREPARATION_WINDOW_MS,
      });
      return resource;
    })();

    pendingPreparations.set(key, preparation);
    return preparation;
  };
}

function guardSignUpResource(
  signUp: SignUpResource,
  guardedResources: WeakSet<SignUpResource>,
  activePreparations: Map<string, ActivePreparation>,
): void {
  if (guardedResources.has(signUp)) {
    return;
  }
  guardedResources.add(signUp);

  const originalCreate = signUp.create.bind(signUp);
  const originalPrepare = signUp.prepareEmailAddressVerification.bind(signUp);
  const guardedPrepare = createPreparationGuard<
    SignUpResource,
    SignUpPrepareParams
  >({
    activePreparations,
    getVerification: (resource) => {
      return resource.verifications.emailAddress;
    },
    key: () => {
      return SIGN_UP_EMAIL_CODE_KEY;
    },
    prepare: originalPrepare,
    resource: signUp,
  });

  signUp.create = async (
    params: SignUpCreateParams,
  ): Promise<SignUpResource> => {
    const resource = await originalCreate(params);
    if (!signUpCreateSendsEmailCode(params)) {
      activePreparations.delete(SIGN_UP_EMAIL_CODE_KEY);
      return resource;
    }

    const preparedAt = now();
    activePreparations.set(SIGN_UP_EMAIL_CODE_KEY, {
      fingerprint: activeEmailCodeFingerprint(
        resource.verifications.emailAddress,
        preparedAt,
      ),
      suppressUntil: preparedAt + AUTOMATIC_PREPARATION_WINDOW_MS,
    });
    return resource;
  };

  signUp.prepareEmailAddressVerification = (
    params?: SignUpPrepareParams,
  ): Promise<SignUpResource> => {
    if (params?.strategy && params.strategy !== "email_code") {
      return originalPrepare(params);
    }
    return guardedPrepare(params);
  };
}

function guardSignInResource(
  signIn: SignInResource,
  guardedResources: WeakSet<SignInResource>,
  activePreparations: Map<string, ActivePreparation>,
): void {
  if (guardedResources.has(signIn)) {
    return;
  }
  guardedResources.add(signIn);

  const originalPrepare = signIn.prepareFirstFactor.bind(signIn);
  const guardedPrepare = createPreparationGuard<
    SignInResource,
    SignInPrepareParams
  >({
    activePreparations,
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
  const signInActivePreparations = new Map<string, ActivePreparation>();
  const signUpActivePreparations = new Map<string, ActivePreparation>();
  const guardedSignInResources = new WeakSet<SignInResource>();
  const guardedSignUpResources = new WeakSet<SignUpResource>();
  const guardCurrentResources = (): void => {
    if (!clerk.client) {
      return;
    }
    guardSignUpResource(
      clerk.client.signUp,
      guardedSignUpResources,
      signUpActivePreparations,
    );
    guardSignInResource(
      clerk.client.signIn,
      guardedSignInResources,
      signInActivePreparations,
    );
  };

  guardCurrentResources();
  clerk.addListener(guardCurrentResources);
}
