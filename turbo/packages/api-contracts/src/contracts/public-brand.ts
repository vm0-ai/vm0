import { z } from "zod";

export const PUBLIC_BRANDS = ["vm0", "okou"] as const;

// Presentation identity only. PublicBrand must not be used as an
// authorization, tenancy, or billing boundary.
export const publicBrandSchema = z.enum(PUBLIC_BRANDS);

export type PublicBrand = z.infer<typeof publicBrandSchema>;
