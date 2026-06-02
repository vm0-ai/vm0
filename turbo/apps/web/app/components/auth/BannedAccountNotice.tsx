"use client";

import { useSignIn } from "@clerk/nextjs";
import Link from "next/link";
import {
  BANNED_ACCOUNT_ERROR_CODE,
  SUPPORT_EMAIL,
  TERMS_OF_USE_URL,
} from "./banned-account-message";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

export function BannedAccountNotice() {
  const { errors } = useSignIn();
  const hasBannedError =
    (errors.global ?? []).some((error) => {
      return error.code === BANNED_ACCOUNT_ERROR_CODE;
    }) ||
    (errors.raw ?? []).some((error) => {
      return errorCode(error) === BANNED_ACCOUNT_ERROR_CODE;
    });

  if (!hasBannedError) {
    return null;
  }

  return (
    <section
      aria-live="polite"
      className="mx-auto w-full rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-foreground"
      role="alert"
    >
      <h2 className="text-sm font-medium text-foreground">
        Account access suspended
      </h2>
      <p className="mt-2 text-muted-foreground">
        Your account access has been suspended because activity on this account
        violated the vm0 Terms of Use.
      </p>
      <p className="mt-3 text-muted-foreground">
        Review the{" "}
        <Link
          className="font-medium text-primary hover:text-primary/90"
          href={TERMS_OF_USE_URL}
        >
          vm0 Terms of Use
        </Link>
        . If you have questions, contact{" "}
        <a
          className="font-medium text-primary hover:text-primary/90"
          href={`mailto:${SUPPORT_EMAIL}`}
        >
          {SUPPORT_EMAIL}
        </a>
        .
      </p>
    </section>
  );
}
