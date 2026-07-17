"""Validated model usage pricing contract."""

from collections.abc import Mapping
from dataclasses import dataclass

import flow_metadata_keys as metadata_keys

from .model_tokens import MODEL_USAGE_CATEGORIES


@dataclass(frozen=True)
class ModelUsagePricing:
    """Validated model token prices used while constructing usage events."""

    unit_size: int
    unit_prices: dict[str, int]


def from_flow_metadata(meta: Mapping[str, object]) -> ModelUsagePricing | None:
    """Read one complete pricing schedule from primitive flow metadata."""
    value = meta.get(metadata_keys.MODEL_USAGE_PRICING)
    if not isinstance(value, dict) or set(value) != {"unitSize", "unitPrices"}:
        return None
    return parse_model_usage_pricing(value["unitSize"], value["unitPrices"])


def parse_model_usage_pricing(
    unit_size: object,
    raw_unit_prices: object,
) -> ModelUsagePricing | None:
    """Construct an atomic schedule or reject all of its prices."""
    if not isinstance(unit_size, int) or isinstance(unit_size, bool) or unit_size <= 0:
        return None
    if not isinstance(raw_unit_prices, dict) or set(raw_unit_prices) != set(MODEL_USAGE_CATEGORIES):
        return None
    unit_prices: dict[str, int] = {}
    for category in MODEL_USAGE_CATEGORIES:
        unit_price = raw_unit_prices[category]
        if not isinstance(unit_price, int) or isinstance(unit_price, bool) or unit_price < 0:
            return None
        unit_prices[category] = unit_price
    return ModelUsagePricing(unit_size=unit_size, unit_prices=unit_prices)
