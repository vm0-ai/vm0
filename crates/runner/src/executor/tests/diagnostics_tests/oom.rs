use super::super::super::diagnostics::{
    HostOomEvidenceSince, dmesg_indicates_oom, host_dmesg_indicates_oom,
};

fn since_micros(micros: i128) -> HostOomEvidenceSince {
    HostOomEvidenceSince::from_micros(micros)
}

#[test]
fn dmesg_oom_positive() {
    assert!(dmesg_indicates_oom(
        "[  12.345] Out of memory: Killed process 1234 (claude)"
    ));
    assert!(dmesg_indicates_oom("oom-kill:constraint=CONSTRAINT_MEMCG"));
    assert!(dmesg_indicates_oom("oom_reaper: reaped process 42"));
}

#[test]
fn dmesg_oom_negative() {
    assert!(!dmesg_indicates_oom(""));
    // "Killed process" alone (without OOM context) should NOT match
    assert!(!dmesg_indicates_oom("Killed process 42 (node)"));
    assert!(!dmesg_indicates_oom("normal kernel log output"));
    assert!(!dmesg_indicates_oom("[  1.000] eth0: link up"));
    assert!(!dmesg_indicates_oom("task killed by signal 15"));
    // substring "oom" in unrelated words should not match
    assert!(!dmesg_indicates_oom("the room is full"));
}

#[test]
fn dmesg_oom_case_insensitive() {
    assert!(dmesg_indicates_oom("Out Of Memory: killed process 99"));
    assert!(!dmesg_indicates_oom("Killed process 99 (agent)"));
    assert!(dmesg_indicates_oom("OOM-kill: constraint=MEMCG"));
}

/// Real `sudo dmesg | grep 'oom-kill'` output captured from prod-3.
const PROD3_OOM_GREP: &str = "\
        [1718300.650867] fc_vcpu 0 invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=0\n\
        [1718300.651117] oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=vm0-runner-v0.45.6.service,mems_allowed=0,oom_memcg=/system.slice/vm0-runner-v0.45.6.service,task_memcg=/system.slice/vm0-runner-v0.45.6.service,task=firecracker,pid=586629,uid=1000";

#[test]
fn host_oom_matches_real_prod3_output() {
    assert!(host_dmesg_indicates_oom(
        PROD3_OOM_GREP,
        586629,
        since_micros(1_718_300_651_117),
    ));
}

#[test]
fn host_oom_rejects_stale_same_pid_record() {
    assert!(!host_dmesg_indicates_oom(
        PROD3_OOM_GREP,
        586629,
        since_micros(1_718_300_651_118),
    ));
}

#[test]
fn host_oom_no_match_different_pid() {
    assert!(!host_dmesg_indicates_oom(
        PROD3_OOM_GREP,
        12345,
        since_micros(0),
    ));
}

#[test]
fn host_oom_no_match_different_process() {
    // Same structure as prod-3 but task=node instead of task=firecracker
    let dmesg = "[1718300.651117] oom-kill:constraint=CONSTRAINT_MEMCG,\
            task=node,pid=586629,uid=1000";
    assert!(!host_dmesg_indicates_oom(dmesg, 586629, since_micros(0),));
}

#[test]
fn host_oom_no_match_empty() {
    assert!(!host_dmesg_indicates_oom("", 12345, since_micros(0),));
}

#[test]
fn host_oom_no_match_without_oom_kill() {
    // Has the PID pattern but no oom-kill keyword
    let dmesg = "[1718300.651117] task=firecracker,pid=12345,uid=1000 started";
    assert!(!host_dmesg_indicates_oom(dmesg, 12345, since_micros(0),));
}

#[test]
fn host_oom_no_prefix_match() {
    // pid=58662 must NOT match pid=586629
    assert!(!host_dmesg_indicates_oom(
        PROD3_OOM_GREP,
        58662,
        since_micros(0),
    ));
}

#[test]
fn host_oom_pid_at_end_of_line() {
    // PID at end of string (no trailing comma) — edge case
    let dmesg = "[0.000000] oom-kill:constraint=CONSTRAINT_MEMCG,task=firecracker,pid=42";
    assert!(host_dmesg_indicates_oom(dmesg, 42, since_micros(0)));
    assert!(!host_dmesg_indicates_oom(dmesg, 4, since_micros(0)));
}

#[test]
fn host_oom_requires_marker_and_pid_in_same_record() {
    let dmesg = "[1.000000] oom-kill:constraint=CONSTRAINT_MEMCG,task=node,pid=7\n\
                 [2.000000] task=firecracker,pid=42,uid=1000";
    assert!(!host_dmesg_indicates_oom(dmesg, 42, since_micros(0),));
}

#[test]
fn host_oom_rejects_missing_or_malformed_timestamp() {
    let missing = "oom-kill:constraint=CONSTRAINT_MEMCG,task=firecracker,pid=42";
    let malformed = "[1.00000x] oom-kill:constraint=CONSTRAINT_MEMCG,task=firecracker,pid=42";

    assert!(!host_dmesg_indicates_oom(missing, 42, since_micros(0),));
    assert!(!host_dmesg_indicates_oom(malformed, 42, since_micros(0),));
}
