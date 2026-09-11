import { Resend } from "resend";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";

const L = logger("ResendLifecycle");
const USER_CREATED_EVENT = "user.created";

function propertyOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Reflect.get(value, key);
}

function stringPropertyOf(value: unknown, key: string): string | undefined {
  const property = propertyOf(value, key);
  return typeof property === "string" && property.trim().length > 0
    ? property.trim()
    : undefined;
}

function numberPropertyOf(value: unknown, key: string): number | undefined {
  const property = propertyOf(value, key);
  return typeof property === "number" && Number.isFinite(property)
    ? property
    : undefined;
}

function errorMessage(error: unknown): string {
  return stringPropertyOf(error, "message") ?? String(error);
}

interface UserCreatedIdentity {
  readonly userId: string;
  readonly email: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly registeredAt: string;
}

function userCreatedIdentity(data: unknown): UserCreatedIdentity | undefined {
  const userId = stringPropertyOf(data, "id");
  const emailAddresses = propertyOf(data, "email_addresses");
  const camelEmailAddresses = propertyOf(data, "emailAddresses");
  const addresses = Array.isArray(emailAddresses)
    ? emailAddresses
    : Array.isArray(camelEmailAddresses)
      ? camelEmailAddresses
      : [];
  const primaryEmailAddressId =
    stringPropertyOf(data, "primary_email_address_id") ??
    stringPropertyOf(data, "primaryEmailAddressId");
  const primaryAddress =
    addresses.find((address) => {
      return (
        primaryEmailAddressId !== undefined &&
        stringPropertyOf(address, "id") === primaryEmailAddressId
      );
    }) ?? addresses[0];
  const email =
    stringPropertyOf(primaryAddress, "email_address") ??
    stringPropertyOf(primaryAddress, "emailAddress");

  if (!userId || !email || !email.includes("@")) {
    return undefined;
  }

  const createdAtMilliseconds =
    numberPropertyOf(data, "created_at") ?? numberPropertyOf(data, "createdAt");
  const createdAt =
    createdAtMilliseconds === undefined
      ? nowDate()
      : new Date(createdAtMilliseconds);
  const registeredAt = Number.isFinite(createdAt.getTime())
    ? createdAt.toISOString()
    : nowDate().toISOString();
  const firstName =
    stringPropertyOf(data, "first_name") ?? stringPropertyOf(data, "firstName");
  const lastName =
    stringPropertyOf(data, "last_name") ?? stringPropertyOf(data, "lastName");

  return {
    userId,
    email,
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    registeredAt,
  };
}

type ResendClient = Pick<Resend, "contacts" | "events">;

async function upsertContact(
  resend: ResendClient,
  identity: UserCreatedIdentity,
): Promise<void> {
  const created = await resend.contacts.create({
    email: identity.email,
    firstName: identity.firstName,
    lastName: identity.lastName,
  });
  if (!created.error) {
    return;
  }

  // A new Clerk event can race with the daily audience sync. Treat an existing
  // Resend contact as an upsert, while leaving its unsubscribe state untouched.
  const existing = await resend.contacts.get({ email: identity.email });
  if (existing.error) {
    throw new Error(
      `Could not create or find Resend contact: ${errorMessage(created.error)}; ${errorMessage(existing.error)}`,
    );
  }

  const updated = await resend.contacts.update({
    email: identity.email,
    firstName: identity.firstName,
    lastName: identity.lastName,
  });
  if (updated.error) {
    throw new Error(
      `Could not update existing Resend contact: ${errorMessage(updated.error)}`,
    );
  }
}

/**
 * Starts the Resend onboarding Automation for a newly registered production
 * user. The Automation itself remains the source of truth for the drip timing.
 */
export async function sendUserCreatedLifecycleEvent(
  data: unknown,
): Promise<void> {
  if (env("ENV") !== "production") {
    L.debug("skipping lifecycle event outside production");
    return;
  }

  const apiKey = optionalEnv("RESEND_API_KEY");
  if (!apiKey) {
    L.error("cannot send lifecycle event without RESEND_API_KEY");
    return;
  }

  const identity = userCreatedIdentity(data);
  if (!identity) {
    L.error("user.created event missing a valid user email or ID");
    return;
  }

  const resend = new Resend(apiKey);
  const contactSync = await settle(upsertContact(resend, identity));
  if (!contactSync.ok) {
    // Contact metadata is helpful for personalization, but it must not block
    // the lifecycle event. Resend can create the contact when the event runs.
    L.warn("could not synchronize Resend contact before lifecycle event", {
      userId: identity.userId,
      error: contactSync.error,
    });
  }

  const result = await resend.events.send({
    event: USER_CREATED_EVENT,
    email: identity.email,
    payload: {
      user_id: identity.userId,
      first_name: identity.firstName ?? "",
      last_name: identity.lastName ?? "",
      registered_at: identity.registeredAt,
    },
  });
  if (result.error) {
    throw new Error(
      `Could not send Resend ${USER_CREATED_EVENT} event: ${errorMessage(result.error)}`,
    );
  }

  L.debug("sent Resend user.created lifecycle event", {
    userId: identity.userId,
  });
}
