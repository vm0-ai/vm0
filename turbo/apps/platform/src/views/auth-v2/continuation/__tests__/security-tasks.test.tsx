import { act, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  mockedClerk,
  mockSignUpConfiguration,
  type MockedClientSession,
} from "../../../../__tests__/mock-auth.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../../__tests__/page-helper.ts";
import { testContext } from "../../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../../signals/utils.ts";

const context = testContext();

async function button(name: string) {
  return await waitFor(() => {
    const element = queryAllByRoleFast("button").find((item) => {
      return (
        item.getAttribute("aria-label") === name ||
        item.textContent?.trim() === name
      );
    });
    if (!element) {
      throw new Error(`Missing button: ${name}`);
    }
    return element;
  });
}

function setupTask(task: string, mode = "sign-in") {
  const session: MockedClientSession = {
    id: "session_pending",
    status: "pending",
    currentTask: { key: task },
    user: {
      primaryEmailAddress: { emailAddress: "member@example.com" },
      organizationMemberships: [
        {
          id: "membership_one",
          organization: { id: "org_one", name: "Our team" },
        },
      ],
    },
  };
  return setupPage({
    context,
    host: "app.vm0.ai",
    path: `/${mode}/tasks/${task}?redirect_url=${encodeURIComponent("https://app.vm0.ai/agents")}`,
    auth: {
      user: {
        id: "user_member",
        fullName: "Member",
        clientSessions: [session],
      },
      session: { token: "test-token" },
      organization: { activeOrg: null, memberships: [] },
    },
  });
}

function completeOnActivation() {
  mockedClerk.setActive.mockImplementation(async (params) => {
    await params.navigate?.({
      session: {
        id: "session_pending",
        status: "active",
        user: { organizationMemberships: [] },
      },
      decorateUrl: (url) => {
        return url;
      },
    });
  });
}

test.each(["sign-in", "sign-up"])(
  "A %s refresh restores a required password task and retries activation without changing the password twice",
  async (mode) => {
    mockedClerk.userUpdatePassword.mockResolvedValue(undefined);
    mockedClerk.setActive.mockRejectedValueOnce(new Error("private-token"));
    await setupTask("reset-password", mode);
    await screen.findByRole("heading", { name: "Set new password" });
    expect(mockedClerk.userUpdatePassword).not.toHaveBeenCalled();
    await fill(
      screen.getByLabelText("New password"),
      "A strong new password 123!",
    );
    await fill(screen.getByLabelText("Confirm password"), "does not match");
    click(await button("Reset password"));
    await screen.findByText("Passwords don't match.");
    expect(mockedClerk.userUpdatePassword).not.toHaveBeenCalled();
    await fill(
      screen.getByLabelText("Confirm password"),
      "A strong new password 123!",
    );
    click(await button("Reset password"));
    await screen.findByText(
      "Your security settings are saved. Continue to finish signing in.",
    );
    expect(document.body).not.toHaveTextContent("private-token");
    expect(mockedClerk.userUpdatePassword).toHaveBeenCalledExactlyOnceWith({
      newPassword: "A strong new password 123!",
      signOutOfOtherSessions: true,
    });
    completeOnActivation();
    click(await button("Continue"));
    await waitFor(() => {
      return expect(location.pathname).toBe("/agents");
    });
    expect(mockedClerk.userUpdatePassword).toHaveBeenCalledTimes(1);
  },
);

test("A rejected password stays editable and can be corrected", async () => {
  mockedClerk.userUpdatePassword
    .mockRejectedValueOnce({
      errors: [
        {
          code: "form_password_pwned",
          message: "password=secret person@example.com",
        },
      ],
    })
    .mockResolvedValueOnce(undefined);
  completeOnActivation();
  await setupTask("reset-password");
  await fill(await screen.findByLabelText("New password"), "weak");
  await fill(screen.getByLabelText("Confirm password"), "weak");
  click(await button("Reset password"));
  await screen.findByText(
    "Your password could not be updated. Choose a stronger password and try again.",
  );
  expect(document.body).not.toHaveTextContent("password=secret");
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  await fill(
    screen.getByLabelText("New password"),
    "A much stronger password 123!",
  );
  await fill(
    screen.getByLabelText("Confirm password"),
    "A much stronger password 123!",
  );
  click(await button("Reset password"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/agents");
  });
});

test("Authenticator enrollment retries an invalid code, displays backup codes, then continues to the next task", async () => {
  mockSignUpConfiguration({
    attributes: {
      authenticator_app: {
        enabled: true,
        required: false,
        used_for_first_factor: false,
      },
    },
  });
  const preparation = createDeferredPromise<{
    secret: string;
    backupCodes: string[];
  }>(context.signal);
  mockedClerk.userCreateTOTP.mockReturnValue(preparation.promise);
  mockedClerk.userVerifyTOTP
    .mockRejectedValueOnce(new Error("secret=PRIVATE-KEY"))
    .mockResolvedValueOnce({});
  mockedClerk.setActive.mockImplementation(async (params) => {
    await params.navigate?.({
      session: {
        id: "session_pending",
        status: params.organization ? "active" : "pending",
        ...(params.organization
          ? {}
          : { currentTask: { key: "choose-organization" } }),
        user: {
          organizationMemberships: [
            {
              id: "member_one",
              organization: { id: "org_one", name: "Our team" },
            },
          ],
        },
      },
      decorateUrl: (url) => {
        return url;
      },
    });
  });
  await setupTask("setup-mfa");
  const prepare = await button("Use an authenticator app");
  click(prepare);
  click(prepare);
  await waitFor(() => {
    return expect(prepare).toBeDisabled();
  });
  expect(mockedClerk.userCreateTOTP).toHaveBeenCalledTimes(1);
  await act(async () => {
    preparation.resolve({
      secret: "AUTHENTICATOR-SETUP-KEY",
      backupCodes: ["backup-one", "backup-two"],
    });
    await preparation.promise;
  });
  await screen.findByText("AUTHENTICATOR-SETUP-KEY");
  await fill(screen.getByLabelText("Verification code"), "111111");
  click(await button("Verify"));
  await screen.findByRole("alert");
  expect(document.body).not.toHaveTextContent("PRIVATE-KEY");
  expect(screen.getByText("AUTHENTICATOR-SETUP-KEY")).toBeVisible();
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  await fill(screen.getByLabelText("Verification code"), "123456");
  click(await button("Verify"));
  await screen.findByRole("list", { name: "Save your backup codes" });
  expect(screen.getByText("backup-one")).toBeVisible();
  expect(screen.queryByText("AUTHENTICATOR-SETUP-KEY")).not.toBeInTheDocument();
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  click(await button("I saved my codes"));
  await screen.findByRole("heading", { name: "Choose an organization" });
  click(await button("Continue with Our team"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/agents");
  });
  expect(mockedClerk.userVerifyTOTP).toHaveBeenLastCalledWith({
    code: "123456",
  });
});

test("SMS enrollment retries sending and enabling without recreating or reverifying the phone", async () => {
  mockSignUpConfiguration({
    attributes: {
      phone_number: {
        enabled: true,
        required: false,
        used_for_first_factor: false,
        used_for_second_factor: true,
      },
    },
  });
  type Phone = Awaited<ReturnType<typeof mockedClerk.userCreatePhoneNumber>>;
  const prepare = vi
    .fn<Phone["prepareVerification"]>()
    .mockRejectedValueOnce(new Error("sms-unavailable"))
    .mockResolvedValue(undefined);
  const verify = vi.fn<Phone["attemptVerification"]>();
  const reserve = vi.fn<Phone["setReservedForSecondFactor"]>();
  const phone: Phone = {
    id: "phone_one",
    phoneNumber: "+15555550123",
    verification: { status: "unverified" },
    prepareVerification: prepare,
    attemptVerification: verify,
    setReservedForSecondFactor: reserve,
  };
  verify.mockResolvedValue({ ...phone, verification: { status: "verified" } });
  reserve
    .mockRejectedValueOnce(new Error("reserve failed"))
    .mockResolvedValue(phone);
  mockedClerk.userCreatePhoneNumber.mockResolvedValue(phone);
  completeOnActivation();
  await setupTask("setup-mfa");
  expect(
    queryAllByRoleFast("button").some((item) => {
      return item.textContent === "Use an authenticator app";
    }),
  ).toBeFalsy();
  await fill(await screen.findByLabelText("Phone number"), phone.phoneNumber);
  click(await button("Send code"));
  await screen.findByRole("alert");
  click(await button("Send code"));
  await fill(await screen.findByLabelText("Verification code"), "123456");
  expect(mockedClerk.userCreatePhoneNumber).toHaveBeenCalledTimes(1);
  expect(reserve).not.toHaveBeenCalled();
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  click(await button("Verify"));
  await screen.findByRole("alert");
  expect(verify).toHaveBeenCalledTimes(1);
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  click(await button("Verify"));
  await screen.findByText(
    "Your security settings are saved. Continue to finish signing in.",
  );
  expect(verify).toHaveBeenCalledExactlyOnceWith({ code: "123456" });
  expect(reserve).toHaveBeenCalledTimes(2);
  expect(reserve).toHaveBeenLastCalledWith({ reserved: true });
  click(await button("Continue"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/agents");
  });
});

test("Backup codes are saved before activation and activation retries do not rotate them", async () => {
  mockSignUpConfiguration({
    attributes: {
      authenticator_app: {
        enabled: true,
        required: false,
        used_for_first_factor: false,
      },
      backup_code: {
        enabled: true,
        required: false,
        used_for_first_factor: false,
      },
    },
  });
  mockedClerk.userCreateTOTP.mockResolvedValue({ secret: "SETUP-KEY" });
  mockedClerk.userVerifyTOTP.mockResolvedValue({});
  mockedClerk.userCreateBackupCode
    .mockRejectedValueOnce(new Error("backup generation failed"))
    .mockResolvedValueOnce({
      codes: ["recovery-code-one", "recovery-code-two"],
    });
  mockedClerk.setActive.mockRejectedValueOnce(new Error("activation failed"));
  await setupTask("setup-mfa");
  click(await button("Use an authenticator app"));
  await fill(await screen.findByLabelText("Verification code"), "123456");
  click(await button("Verify"));
  click(await button("Continue"));
  await screen.findByRole("alert");
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  click(await button("Continue"));
  await screen.findByRole("list", { name: "Save your backup codes" });
  expect(screen.getByText("recovery-code-one")).toBeVisible();
  expect(mockedClerk.userVerifyTOTP).toHaveBeenCalledTimes(1);
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  click(await button("I saved my codes"));
  await screen.findByRole("alert");
  expect(screen.getByText("recovery-code-one")).toBeVisible();
  completeOnActivation();
  click(await button("I saved my codes"));
  await waitFor(() => {
    expect(location.pathname).toBe("/agents");
  });
  expect(mockedClerk.userCreateBackupCode).toHaveBeenCalledTimes(2);
});
