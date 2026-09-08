import {
  runnerSshContract,
  runnerSshInvalidateSchema,
} from "../contracts/runner-ssh";
import {
  SSH_PRIVATE_KEY_MAX_LENGTH,
  SSH_PASSPHRASE_MAX_LENGTH,
} from "../contracts/ssh-connections";
import type { RustTypeBinding, RustTypeDeclarationDoc } from "./types";

function identityDocs(name: string): RustTypeDeclarationDoc {
  return {
    rustTypeName: name,
    rustDoc: ["Immutable winning official Runner process."],
    fields: {
      runnerId: ["Runner UUID."],
      heartbeatGeneration: ["Winning process generation."],
    },
  };
}

function hostKeyDocs(name: string): RustTypeDeclarationDoc[] {
  return [
    {
      rustTypeName: name,
      rustDoc: [
        "Learned SSH host identity, distinct from the negotiated signature algorithm.",
      ],
      fields: {
        algorithm: ["Public key algorithm."],
        fingerprint: ["Canonical unpadded SHA256 fingerprint."],
      },
    },
    {
      rustTypeName: `${name}Algorithm`,
      rustDoc: ["Supported host public-key identities."],
      variants: {
        "ssh-ed25519": ["Ed25519."],
        "ecdsa-sha2-nistp256": ["NIST P256."],
        "ecdsa-sha2-nistp384": ["NIST P384."],
        "ecdsa-sha2-nistp521": ["NIST P521."],
        "ssh-rsa": ["RSA public-key identity; negotiate RSA-SHA2 separately."],
      },
    },
  ];
}

export const sshTypeBindings = [
  {
    schema: runnerSshInvalidateSchema,
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "InvalidateNotification",
    direction: "response",
    declarations: [
      {
        rustTypeName: "InvalidateNotification",
        rustDoc: [
          "Best-effort SSH authority eviction, never an authorization grant.",
        ],
        fields: {
          runId: ["Affected active Run UUID."],
          connectionId: [
            "Affected connection UUID, or null for every connection in the Run.",
          ],
        },
      },
    ],
  },
  {
    schema: runnerSshContract.resolve.body,
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "ResolveRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "ResolveRequest",
        rustDoc: ["Resolve current authority for one Run connection."],
        fields: {
          connectionId: ["Exact SSH connection UUID."],
          runnerIdentity: ["Host-owned process identity."],
        },
      },
      identityDocs("ResolveRequestRunnerIdentity"),
    ],
  },
  {
    schema: runnerSshContract.pin.body,
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "PinRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "PinRequest",
        rustDoc: [
          "Learn the first key only under current authority and generation.",
        ],
        fields: {
          connectionId: ["Exact SSH connection UUID."],
          runnerIdentity: ["Host-owned process identity."],
          expectedGeneration: ["Generation delivered by JIT."],
          observedHostKey: ["Identity after KEX proof verification."],
        },
      },
      identityDocs("PinRequestRunnerIdentity"),
      ...hostKeyDocs("PinRequestObservedHostKey"),
    ],
  },
  {
    schema: runnerSshContract.pin.responses[200],
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "PinResponse",
    direction: "response",
    declarations: [
      {
        rustTypeName: "PinResponse",
        rustDoc: ["Atomic first-use trust outcome."],
        fields: { generation: ["Must equal the JIT generation plus one."] },
        variants: {
          unavailable: ["Current authority no longer exists."],
          pinned: ["This observation won the pin."],
          matched: [
            "Same observation won concurrently at exactly generation plus one.",
          ],
          host_key_mismatch: ["Trust differs; never overwrite."],
          configuration_changed: ["JIT configuration is stale."],
        },
      },
    ],
  },
  {
    schema: runnerSshContract.resolve.responses[200],
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "ResolveResponse",
    direction: "response",
    sensitive: true,
    fieldTypeOverrides: {
      privateKey: `crate::SecretText<${SSH_PRIVATE_KEY_MAX_LENGTH}>`,
      passphrase: `Option<crate::SecretText<${SSH_PASSPHRASE_MAX_LENGTH}>>`,
    },
    declarations: [
      {
        rustTypeName: "ResolveResponse",
        rustDoc: [
          "Private JIT response. Never Debug, clone, serialize, persist or send to guest.",
        ],
        fields: {
          host: ["Current destination, private to Runner."],
          port: ["Current destination port."],
          username: ["Current login identity."],
          generation: ["Current configuration generation."],
          learnedHostKey: ["Existing pin, or first-use trust required."],
          privateKey: ["Bounded zeroizing private key text."],
          passphrase: ["Bounded zeroizing passphrase, preserving whitespace."],
        },
        variants: {
          unavailable: ["Current authority not available; no secrets."],
          resolved: ["Authorized current credential handoff."],
        },
      },
      ...hostKeyDocs("ResolveResponseResolvedLearnedHostKey"),
    ],
  },
] satisfies readonly RustTypeBinding[];
