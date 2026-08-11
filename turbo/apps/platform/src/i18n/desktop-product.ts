import {
  desktopProductFromClientHeader,
  type DesktopProduct,
} from "@vm0/api-contracts/contracts/client-headers";

export function desktopProductDisplayName(
  product: DesktopProduct | undefined,
): "Zero" | "Okou" {
  return desktopProductFromClientHeader(product) === "okou" ? "Okou" : "Zero";
}
