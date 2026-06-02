import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  BANNED_ACCOUNT_ERROR_CODE,
  SUPPORT_EMAIL,
  TERMS_OF_USE_URL,
} from "../banned-account-message";
import { BannedAccountNotice } from "../BannedAccountNotice";

interface MockSignInErrors {
  readonly fields: {
    readonly identifier: null;
    readonly password: null;
    readonly code: null;
  };
  readonly raw: readonly unknown[] | null;
  readonly global:
    | readonly {
        readonly code: string;
        readonly message: string;
        readonly longMessage?: string;
      }[]
    | null;
}

const signInErrors: { current: MockSignInErrors } = vi.hoisted(() => {
  return {
    current: {
      fields: {
        identifier: null,
        password: null,
        code: null,
      },
      raw: null,
      global: null,
    },
  };
});

vi.mock("@clerk/nextjs", () => {
  return {
    useSignIn: () => {
      return {
        errors: signInErrors.current,
      };
    },
  };
});

vi.mock("next/link", () => {
  return {
    default: ({
      children,
      className,
      href,
    }: {
      readonly children: ReactNode;
      readonly className?: string;
      readonly href: string;
    }) => {
      return (
        <a className={className} href={href}>
          {children}
        </a>
      );
    },
  };
});

describe("BannedAccountNotice", () => {
  it("does not render without a banned account error", () => {
    signInErrors.current = {
      fields: {
        identifier: null,
        password: null,
        code: null,
      },
      raw: null,
      global: null,
    };

    expect(renderToStaticMarkup(<BannedAccountNotice />)).toBe("");
  });

  it("renders terms and support contact when Clerk reports a banned account", () => {
    signInErrors.current = {
      fields: {
        identifier: null,
        password: null,
        code: null,
      },
      raw: null,
      global: [
        {
          code: BANNED_ACCOUNT_ERROR_CODE,
          message: "User banned",
          longMessage: "User banned",
        },
      ],
    };

    const html = renderToStaticMarkup(<BannedAccountNotice />);

    expect(html).toContain("Account access suspended");
    expect(html).toContain("violated the vm0 Terms of Use");
    expect(html).toContain(`href="${TERMS_OF_USE_URL}"`);
    expect(html).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
    expect(html).toContain(SUPPORT_EMAIL);
  });
});
