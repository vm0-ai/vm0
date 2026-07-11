use std::time::{Duration, Instant};

use crate::pool::DeviceAcquireSource;

const NBD_COW_CREATE_STAGE_COUNT: usize = NbdCowCreateStage::ALL.len();

/// Fixed stages inside one NBD COW device creation.
///
/// [`Self::DeviceScan`] is nested inside [`Self::DeviceAcquire`]. Every other
/// stage is a peer contribution to the enclosing NBD create operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NbdCowCreateStage {
    CowLayerCreate,
    DeviceAcquire,
    DeviceScan,
    DispatchSetup,
    NetlinkConnect,
    SizeVerify,
    RetryCleanup,
    RetryDelay,
}

impl NbdCowCreateStage {
    /// All stages in stable telemetry order.
    pub const ALL: [Self; 8] = [
        Self::CowLayerCreate,
        Self::DeviceAcquire,
        Self::DeviceScan,
        Self::DispatchSetup,
        Self::NetlinkConnect,
        Self::SizeVerify,
        Self::RetryCleanup,
        Self::RetryDelay,
    ];
}

/// Fixed low-cardinality outcomes for one NBD COW device creation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NbdCowCreateOutcome {
    AcquireSourceDemandScan,
    AcquireSourceCooledClaim,
    EbusyRetriesNone,
    EbusyRetriesOne,
    EbusyRetriesMultiple,
    SizeZeroRetriesNone,
    SizeZeroRetriesOne,
    SizeZeroRetriesMultiple,
}

/// Receives aggregate timing and bounded outcomes for one NBD COW create.
///
/// Stage records are emitted once when creation returns normally. Retry work is
/// accumulated into one contribution per stage instead of emitting one sample
/// per attempt. Cancellation does not invoke observer code from `Drop`.
pub trait NbdCowCreateObserver: Send {
    fn record_stage(&mut self, stage: NbdCowCreateStage, duration: Duration, success: bool);

    fn record_outcome(&mut self, outcome: NbdCowCreateOutcome);
}

#[derive(Clone, Copy, Default)]
struct StageTiming {
    duration: Duration,
    entered: bool,
}

pub(super) struct NbdCowCreateTiming<'a> {
    observer: Option<&'a mut dyn NbdCowCreateObserver>,
    stages: [StageTiming; NBD_COW_CREATE_STAGE_COUNT],
    failed_stage: Option<NbdCowCreateStage>,
    used_demand_scan: bool,
    used_cooled_claim: bool,
    ebusy_retries: u32,
    size_zero_retries: u32,
}

impl<'a> NbdCowCreateTiming<'a> {
    pub(super) fn new(observer: Option<&'a mut dyn NbdCowCreateObserver>) -> Self {
        Self {
            observer,
            stages: [StageTiming::default(); NBD_COW_CREATE_STAGE_COUNT],
            failed_stage: None,
            used_demand_scan: false,
            used_cooled_claim: false,
            ebusy_retries: 0,
            size_zero_retries: 0,
        }
    }

    pub(super) fn record_stage(
        &mut self,
        stage: NbdCowCreateStage,
        started_at: Instant,
        success: bool,
    ) {
        self.record_stage_duration(stage, started_at.elapsed(), success);
    }

    pub(super) fn record_stage_duration(
        &mut self,
        stage: NbdCowCreateStage,
        duration: Duration,
        success: bool,
    ) {
        let timing = self.stage_mut(stage);
        timing.duration = timing.duration.saturating_add(duration);
        timing.entered = true;
        if !success {
            self.failed_stage = Some(stage);
        }
    }

    pub(super) fn record_acquisition(
        &mut self,
        source: DeviceAcquireSource,
        scan_duration: Option<Duration>,
    ) {
        match source {
            DeviceAcquireSource::DemandScan => self.used_demand_scan = true,
            DeviceAcquireSource::CooledClaim => self.used_cooled_claim = true,
        }
        if let Some(duration) = scan_duration {
            self.record_stage_duration(NbdCowCreateStage::DeviceScan, duration, true);
        }
    }

    pub(super) fn record_ebusy_retry(&mut self) {
        self.ebusy_retries = self.ebusy_retries.saturating_add(1);
    }

    pub(super) fn record_size_zero_retry(&mut self) {
        self.size_zero_retries = self.size_zero_retries.saturating_add(1);
    }

    pub(super) fn finish(mut self, create_success: bool) {
        let Some(observer) = self.observer.take() else {
            return;
        };

        for stage in NbdCowCreateStage::ALL {
            let timing = self.stage(stage);
            if !timing.entered {
                continue;
            }
            observer.record_stage(
                stage,
                timing.duration,
                create_success || self.failed_stage != Some(stage),
            );
        }

        if self.used_demand_scan {
            observer.record_outcome(NbdCowCreateOutcome::AcquireSourceDemandScan);
        }
        if self.used_cooled_claim {
            observer.record_outcome(NbdCowCreateOutcome::AcquireSourceCooledClaim);
        }
        observer.record_outcome(ebusy_retry_outcome(self.ebusy_retries));
        observer.record_outcome(size_zero_retry_outcome(self.size_zero_retries));
    }

    fn stage(&self, stage: NbdCowCreateStage) -> StageTiming {
        let [
            cow_layer_create,
            device_acquire,
            device_scan,
            dispatch_setup,
            netlink_connect,
            size_verify,
            retry_cleanup,
            retry_delay,
        ] = &self.stages;
        *match stage {
            NbdCowCreateStage::CowLayerCreate => cow_layer_create,
            NbdCowCreateStage::DeviceAcquire => device_acquire,
            NbdCowCreateStage::DeviceScan => device_scan,
            NbdCowCreateStage::DispatchSetup => dispatch_setup,
            NbdCowCreateStage::NetlinkConnect => netlink_connect,
            NbdCowCreateStage::SizeVerify => size_verify,
            NbdCowCreateStage::RetryCleanup => retry_cleanup,
            NbdCowCreateStage::RetryDelay => retry_delay,
        }
    }

    fn stage_mut(&mut self, stage: NbdCowCreateStage) -> &mut StageTiming {
        let [
            cow_layer_create,
            device_acquire,
            device_scan,
            dispatch_setup,
            netlink_connect,
            size_verify,
            retry_cleanup,
            retry_delay,
        ] = &mut self.stages;
        match stage {
            NbdCowCreateStage::CowLayerCreate => cow_layer_create,
            NbdCowCreateStage::DeviceAcquire => device_acquire,
            NbdCowCreateStage::DeviceScan => device_scan,
            NbdCowCreateStage::DispatchSetup => dispatch_setup,
            NbdCowCreateStage::NetlinkConnect => netlink_connect,
            NbdCowCreateStage::SizeVerify => size_verify,
            NbdCowCreateStage::RetryCleanup => retry_cleanup,
            NbdCowCreateStage::RetryDelay => retry_delay,
        }
    }
}

fn ebusy_retry_outcome(count: u32) -> NbdCowCreateOutcome {
    match count {
        0 => NbdCowCreateOutcome::EbusyRetriesNone,
        1 => NbdCowCreateOutcome::EbusyRetriesOne,
        _ => NbdCowCreateOutcome::EbusyRetriesMultiple,
    }
}

fn size_zero_retry_outcome(count: u32) -> NbdCowCreateOutcome {
    match count {
        0 => NbdCowCreateOutcome::SizeZeroRetriesNone,
        1 => NbdCowCreateOutcome::SizeZeroRetriesOne,
        _ => NbdCowCreateOutcome::SizeZeroRetriesMultiple,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingObserver {
        stages: Vec<(NbdCowCreateStage, Duration, bool)>,
        outcomes: Vec<NbdCowCreateOutcome>,
    }

    impl NbdCowCreateObserver for RecordingObserver {
        fn record_stage(&mut self, stage: NbdCowCreateStage, duration: Duration, success: bool) {
            self.stages.push((stage, duration, success));
        }

        fn record_outcome(&mut self, outcome: NbdCowCreateOutcome) {
            self.outcomes.push(outcome);
        }
    }

    #[test]
    fn timing_aggregates_retries_and_deduplicates_sources() {
        let mut observer = RecordingObserver::default();
        let mut timing = NbdCowCreateTiming::new(Some(&mut observer));
        timing.record_stage_duration(
            NbdCowCreateStage::DeviceAcquire,
            Duration::from_millis(7),
            true,
        );
        timing.record_stage_duration(
            NbdCowCreateStage::DeviceAcquire,
            Duration::from_millis(11),
            true,
        );
        timing.record_acquisition(
            DeviceAcquireSource::DemandScan,
            Some(Duration::from_millis(3)),
        );
        timing.record_acquisition(
            DeviceAcquireSource::DemandScan,
            Some(Duration::from_millis(5)),
        );
        timing.record_acquisition(DeviceAcquireSource::CooledClaim, None);
        timing.record_ebusy_retry();
        timing.record_size_zero_retry();
        timing.record_size_zero_retry();
        timing.finish(true);

        assert_eq!(
            observer.stages,
            vec![
                (
                    NbdCowCreateStage::DeviceAcquire,
                    Duration::from_millis(18),
                    true,
                ),
                (
                    NbdCowCreateStage::DeviceScan,
                    Duration::from_millis(8),
                    true,
                ),
            ]
        );
        assert_eq!(
            observer.outcomes,
            vec![
                NbdCowCreateOutcome::AcquireSourceDemandScan,
                NbdCowCreateOutcome::AcquireSourceCooledClaim,
                NbdCowCreateOutcome::EbusyRetriesOne,
                NbdCowCreateOutcome::SizeZeroRetriesMultiple,
            ]
        );
    }

    #[test]
    fn timing_marks_only_terminal_stage_failed() {
        let mut observer = RecordingObserver::default();
        let mut timing = NbdCowCreateTiming::new(Some(&mut observer));
        timing.record_stage_duration(
            NbdCowCreateStage::DeviceAcquire,
            Duration::from_millis(4),
            false,
        );
        timing.record_stage_duration(
            NbdCowCreateStage::RetryCleanup,
            Duration::from_millis(2),
            true,
        );
        timing.record_stage_duration(
            NbdCowCreateStage::NetlinkConnect,
            Duration::from_millis(6),
            false,
        );
        timing.finish(false);

        assert_eq!(
            observer.stages,
            vec![
                (
                    NbdCowCreateStage::DeviceAcquire,
                    Duration::from_millis(4),
                    true,
                ),
                (
                    NbdCowCreateStage::NetlinkConnect,
                    Duration::from_millis(6),
                    false,
                ),
                (
                    NbdCowCreateStage::RetryCleanup,
                    Duration::from_millis(2),
                    true,
                ),
            ]
        );
        assert_eq!(
            observer.outcomes,
            vec![
                NbdCowCreateOutcome::EbusyRetriesNone,
                NbdCowCreateOutcome::SizeZeroRetriesNone,
            ]
        );
    }
}
