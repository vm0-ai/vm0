/**
 * VM ID Type
 *
 * Branded type for VM identifiers to prevent accidental misuse of strings.
 */

declare const VmIdBrand: unique symbol;

/**
 * Branded type for VM ID
 *
 * VmId is a string with a compile-time brand to prevent accidental misuse.
 * Use `createVmId()` to create a VmId from a runId.
 */
export type VmId = { readonly [VmIdBrand]: never };

/**
 * Create a VmId from a runId (UUID)
 * Extracts first 8 characters for unique identification
 * If input is shorter than 8 chars, pads with zeros
 */
export function createVmId(runId: string): VmId {
  return runId.substring(0, 8).padStart(8, "0") as unknown as VmId;
}

/**
 * Get the string value of a VmId
 */
export function vmIdValue(vmId: VmId): string {
  return vmId as unknown as string;
}
