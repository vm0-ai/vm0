import {
  desktopProductFromClientHeader,
  type DesktopProduct,
} from "@okouai/api-contracts/contracts/client-headers";

export function desktopProductDisplayName(
  product: DesktopProduct | undefined,
): "Zero" | "Okou" {
  return desktopProductFromClientHeader(product) === "okou" ? "Okou" : "Zero";
}
