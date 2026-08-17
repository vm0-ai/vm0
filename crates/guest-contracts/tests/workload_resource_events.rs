use std::io;

use guest_contracts::diagnostics::WorkloadResourceLimitDiagnostic;
use guest_contracts::process_containment::{MATERIAL_CPU_THROTTLED_USEC, WorkloadResourceEvents};

#[test]
fn parses_one_snapshot_for_both_guest_consumers() {
    let events = WorkloadResourceEvents::from_file_contents(
        " usage_usec 10\nnr_throttled\t2\nthrottled_usec 3\nthrottled_usec   1000000 \nnice_usec 4\n",
        "low 0\n high\t4\nmax 5\noom 1\noom_kill 2\noom_group_kill 3\nsock_throttled 6\n",
        "max 7\nfuture_counter 8\n",
    )
    .unwrap();

    assert_eq!(
        events,
        WorkloadResourceEvents {
            cpu_nr_throttled: 2,
            cpu_throttled_usec: MATERIAL_CPU_THROTTLED_USEC,
            memory_high: 4,
            memory_max: 5,
            memory_oom: 1,
            memory_oom_kill: 2,
            memory_oom_group_kill: 3,
            pids_max: 7,
        }
    );
    assert_eq!(
        events.hard_limit_diagnostic(),
        Some(WorkloadResourceLimitDiagnostic {
            memory_max_events: 5,
            memory_oom_events: 1,
            memory_oom_kill_events: 2,
            memory_oom_group_kill_events: 3,
            pids_max_events: 7,
        })
    );
    assert!(events.has_material_pressure());
}

#[test]
fn missing_counters_default_to_no_resource_events() {
    let events = WorkloadResourceEvents::from_file_contents(
        &format!(
            "nr_throttled 2\nthrottled_usec {}\n",
            MATERIAL_CPU_THROTTLED_USEC - 1
        ),
        "high 0\n",
        "",
    )
    .unwrap();

    assert_eq!(events.memory_max, 0);
    assert_eq!(events.memory_oom, 0);
    assert_eq!(events.memory_oom_kill, 0);
    assert_eq!(events.memory_oom_group_kill, 0);
    assert_eq!(events.pids_max, 0);
    assert_eq!(events.hard_limit_diagnostic(), None);
    assert!(!events.has_material_pressure());
}

#[test]
fn rejects_malformed_flat_keyed_contents() {
    for (cpu_stat, memory_events, pids_events) in [
        ("\n", "", ""),
        ("nr_throttled", "", ""),
        ("nr_throttled 1 extra", "", ""),
        ("", "max invalid", ""),
        ("", "", "max 18446744073709551616"),
    ] {
        let error =
            WorkloadResourceEvents::from_file_contents(cpu_stat, memory_events, pids_events)
                .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
