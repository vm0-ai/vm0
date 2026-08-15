use guest_contracts::epoch_milliseconds::{
    MIN_PLAUSIBLE_EPOCH_MILLISECONDS, is_plausible_epoch_milliseconds,
};

#[test]
fn accepts_minimum_and_future_values() {
    for timestamp in [
        MIN_PLAUSIBLE_EPOCH_MILLISECONDS,
        1_700_000_000_000,
        u64::MAX,
    ] {
        assert!(
            is_plausible_epoch_milliseconds(timestamp),
            "expected acceptance for {timestamp}"
        );
    }
}

#[test]
fn rejects_values_below_minimum() {
    for timestamp in [0, 1_700_000_000, MIN_PLAUSIBLE_EPOCH_MILLISECONDS - 1] {
        assert!(
            !is_plausible_epoch_milliseconds(timestamp),
            "expected rejection for {timestamp}"
        );
    }
}
