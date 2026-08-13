use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use guest_contracts::exec_terminal::{
    EXEC_PROCESS_CONTAINMENT_KILL_EMPTY_TIMEOUT, EXEC_PROCESS_CONTAINMENT_REMOVE_TIMEOUT,
    EXEC_PROCESS_CONTAINMENT_TERM_GRACE,
};
use guest_contracts::process_containment::{
    CGROUP_V2_MOUNT_PATH, CONTROL_CGROUP_NAME, CONTROL_CPU_WEIGHT, EXEC_CGROUP_BASE_PATH,
    EXEC_CGROUP_NAME_PREFIX, MATERIAL_CPU_THROTTLED_USEC, REQUIRED_CGROUP_CONTROLLERS,
    REQUIRED_CGROUP_SUBTREE_CONTROL, WORKLOAD_CGROUP_NAME, WorkloadResourcePolicy,
};

use crate::log::log;

const CGROUP_EVENTS_FILE: &str = "cgroup.events";
const CGROUP_KILL_FILE: &str = "cgroup.kill";
const CGROUP_PROCS_FILE: &str = "cgroup.procs";
const CGROUP_SUBTREE_CONTROL_FILE: &str = "cgroup.subtree_control";
const CPU_MAX_FILE: &str = "cpu.max";
const CPU_STAT_FILE: &str = "cpu.stat";
const CPU_WEIGHT_FILE: &str = "cpu.weight";
const MEMORY_EVENTS_FILE: &str = "memory.events";
const MEMORY_HIGH_FILE: &str = "memory.high";
const MEMORY_MAX_FILE: &str = "memory.max";
const MEMORY_MIN_FILE: &str = "memory.min";
const MEMORY_OOM_GROUP_FILE: &str = "memory.oom.group";
const PIDS_EVENTS_FILE: &str = "pids.events";
const PIDS_MAX_FILE: &str = "pids.max";
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const WORKLOAD_BOOTSTRAP_ACCEPT_POLL: Duration = Duration::from_millis(100);
const WORKLOAD_BOOTSTRAP_ENDPOINT_SUFFIX: &str = "-workload-placement";
const THREAD_WORKLOAD_BOOTSTRAP: &str = "vsock-workload-bootstrap";

static NEXT_CGROUP_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) struct ExecProcessContainment {
    backend: ContainmentBackend,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessContainmentCleanupMode {
    Graceful,
    Forced,
}

#[derive(Clone, Copy)]
pub(crate) enum ProcessContainmentMode {
    BuildConfigured,
    TestNoop,
}

enum ContainmentBackend {
    Cgroup(CgroupGuard),
    TestNoop,
    #[cfg(test)]
    TestDirectory(PathBuf),
}

struct CgroupGuard {
    group_name: String,
    group_path: PathBuf,
    outer_placement: OwnedFd,
    workload_placement: Option<OwnedFd>,
    create_elapsed: Duration,
}

pub(crate) struct PreparedProcessContainmentCommand {
    outer_placement: Option<OwnedFd>,
    deny_process_inspection: bool,
}

impl PreparedProcessContainmentCommand {
    pub(crate) fn configure_placement(&mut self, command: &mut Command) {
        if let Some(outer_placement) = self.outer_placement.take() {
            install_child_placement(command, outer_placement);
        }
    }

    pub(crate) fn configure_process_inspection(self, command: &mut Command) {
        if self.deny_process_inspection {
            install_process_inspection_denial(command);
        }
    }
}

pub(crate) struct WorkloadPlacementBootstrap {
    endpoint: String,
    cancel: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl WorkloadPlacementBootstrap {
    pub(crate) fn endpoint(&self) -> &str {
        &self.endpoint
    }
}

impl Drop for WorkloadPlacementBootstrap {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take()
            && let Err(error) = worker.join()
        {
            log(
                "WARN",
                &format!("workload placement bootstrap worker panicked: {error:?}"),
            );
        }
    }
}

#[derive(Debug)]
pub(crate) struct ProcessContainmentError {
    stage: &'static str,
    source: io::Error,
}

impl std::fmt::Display for ProcessContainmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.stage, self.source)
    }
}

impl std::error::Error for ProcessContainmentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

impl ProcessContainmentError {
    fn new(stage: &'static str, source: io::Error) -> Self {
        Self { stage, source }
    }
}

impl ExecProcessContainment {
    pub(crate) fn create(
        sequence: u32,
        mode: ProcessContainmentMode,
        trusted_control: bool,
    ) -> Result<Self, ProcessContainmentError> {
        if use_test_noop_backend(mode) {
            return Ok(Self {
                backend: ContainmentBackend::TestNoop,
            });
        }

        CgroupGuard::create(sequence, trusted_control).map(|guard| Self {
            backend: ContainmentBackend::Cgroup(guard),
        })
    }

    pub(crate) fn prepare_command(
        &self,
    ) -> Result<PreparedProcessContainmentCommand, ProcessContainmentError> {
        match &self.backend {
            ContainmentBackend::Cgroup(guard) => guard.prepare_command(),
            ContainmentBackend::TestNoop => Ok(PreparedProcessContainmentCommand {
                outer_placement: None,
                deny_process_inspection: false,
            }),
            #[cfg(test)]
            ContainmentBackend::TestDirectory(_) => Ok(PreparedProcessContainmentCommand {
                outer_placement: None,
                deny_process_inspection: false,
            }),
        }
    }

    pub(crate) fn start_workload_placement_bootstrap(
        &self,
        control_endpoint: &str,
        expected_uid: libc::uid_t,
    ) -> Result<Option<WorkloadPlacementBootstrap>, ProcessContainmentError> {
        match &self.backend {
            ContainmentBackend::Cgroup(guard) => guard
                .start_workload_placement_bootstrap(control_endpoint, expected_uid)
                .map(Some),
            ContainmentBackend::TestNoop => Ok(None),
            #[cfg(test)]
            ContainmentBackend::TestDirectory(_) => Ok(None),
        }
    }

    pub(crate) fn cleanup(
        self,
        mode: ProcessContainmentCleanupMode,
    ) -> Result<(), ProcessContainmentError> {
        match self.backend {
            ContainmentBackend::Cgroup(guard) => guard.cleanup(mode),
            ContainmentBackend::TestNoop => Ok(()),
            #[cfg(test)]
            ContainmentBackend::TestDirectory(group_path) => fs::remove_dir(group_path)
                .map_err(|error| ProcessContainmentError::new("remove test cgroup", error)),
        }
    }
}

pub(crate) fn verify_exec_process_containment_empty(
    mode: ProcessContainmentMode,
) -> Result<(), ProcessContainmentError> {
    if use_test_noop_backend(mode) {
        return Ok(());
    }
    verify_exec_process_containment_empty_in(Path::new(EXEC_CGROUP_BASE_PATH))
}

fn use_test_noop_backend(mode: ProcessContainmentMode) -> bool {
    // Host-side connection tests pass TestNoop explicitly, while library unit
    // tests and downstream test-support builds select it at compile time.
    // Controlled containment tests exercise real behavior through paths they own.
    matches!(mode, ProcessContainmentMode::TestNoop) || cfg!(test) || cfg!(feature = "test-support")
}

fn verify_exec_process_containment_empty_in(
    base_path: &Path,
) -> Result<(), ProcessContainmentError> {
    for entry in fs::read_dir(base_path)
        .map_err(|error| ProcessContainmentError::new("read exec cgroup base", error))?
    {
        let entry =
            entry.map_err(|error| ProcessContainmentError::new("read exec cgroup entry", error))?;
        if entry
            .file_type()
            .map_err(|error| ProcessContainmentError::new("inspect exec cgroup entry", error))?
            .is_dir()
        {
            return Err(ProcessContainmentError::new(
                "verify exec cgroup empty",
                io::Error::other("exec operation cgroup remains after quiesce"),
            ));
        }
    }

    if read_populated(base_path)? {
        return Err(ProcessContainmentError::new(
            "verify exec cgroup empty",
            io::Error::other("exec cgroup remains populated after quiesce"),
        ));
    }
    Ok(())
}

impl CgroupGuard {
    fn create(sequence: u32, trusted_control: bool) -> Result<Self, ProcessContainmentError> {
        let policy = workload_resource_policy()?;
        Self::create_in(
            Path::new(EXEC_CGROUP_BASE_PATH),
            sequence,
            trusted_control,
            policy,
        )
    }

    fn create_in(
        base_path: &Path,
        sequence: u32,
        trusted_control: bool,
        policy: WorkloadResourcePolicy,
    ) -> Result<Self, ProcessContainmentError> {
        let started = Instant::now();
        let id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
        let group_name = format!(
            "{EXEC_CGROUP_NAME_PREFIX}{}-{sequence}-{id}",
            std::process::id()
        );
        let group_path = base_path.join(&group_name);
        fs::create_dir(&group_path)
            .map_err(|error| ProcessContainmentError::new("create cgroup", error))?;

        let setup: Result<(OwnedFd, Option<OwnedFd>), ProcessContainmentError> = (|| {
            enable_required_controllers(&group_path)?;
            let control_path = group_path.join(CONTROL_CGROUP_NAME);
            let workload_path = group_path.join(WORKLOAD_CGROUP_NAME);
            fs::create_dir(&control_path)
                .map_err(|error| ProcessContainmentError::new("create control cgroup", error))?;
            fs::create_dir(&workload_path)
                .map_err(|error| ProcessContainmentError::new("create workload cgroup", error))?;
            configure_resource_policy(
                &group_path,
                &control_path,
                &workload_path,
                trusted_control,
                policy,
            )?;

            let outer_path = if trusted_control {
                &control_path
            } else {
                &workload_path
            };
            let outer_placement = open_placement(outer_path, "open outer cgroup.procs")?;
            let workload_placement = if trusted_control {
                Some(open_placement(
                    &workload_path,
                    "open workload cgroup.procs",
                )?)
            } else {
                None
            };
            Ok((outer_placement, workload_placement))
        })();

        let (outer_placement, workload_placement) = match setup {
            Ok(placements) => placements,
            Err(original) => {
                if let Err(rollback) = remove_cgroup_hierarchy(&group_path) {
                    log(
                        "ERROR",
                        &format!(
                            "exec process containment creation rollback failed group={group_name} original_stage={} original_error={} rollback_stage={} rollback_error={}",
                            original.stage, original.source, rollback.stage, rollback.source
                        ),
                    );
                }
                return Err(original);
            }
        };

        Ok(Self {
            group_name,
            group_path,
            outer_placement,
            workload_placement,
            create_elapsed: started.elapsed(),
        })
    }

    fn prepare_command(
        &self,
    ) -> Result<PreparedProcessContainmentCommand, ProcessContainmentError> {
        let outer_placement = self
            .outer_placement
            .try_clone()
            .map_err(|error| ProcessContainmentError::new("clone outer cgroup.procs", error))?;
        let trusted_control = self.workload_placement.is_some();
        Ok(PreparedProcessContainmentCommand {
            outer_placement: Some(outer_placement),
            deny_process_inspection: trusted_control,
        })
    }

    fn start_workload_placement_bootstrap(
        &self,
        control_endpoint: &str,
        expected_uid: libc::uid_t,
    ) -> Result<WorkloadPlacementBootstrap, ProcessContainmentError> {
        let placement = self
            .workload_placement
            .as_ref()
            .ok_or_else(|| {
                ProcessContainmentError::new(
                    "prepare workload placement bootstrap",
                    io::Error::other("trusted control cgroup has no workload placement capability"),
                )
            })?
            .try_clone()
            .map_err(|error| {
                ProcessContainmentError::new("clone workload cgroup.procs for bootstrap", error)
            })?;
        let endpoint = format!("{control_endpoint}{WORKLOAD_BOOTSTRAP_ENDPOINT_SUFFIX}");
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).map_err(|error| {
            ProcessContainmentError::new("bind workload placement bootstrap endpoint", error)
        })?;
        let expected_cgroup = self.group_path.join(CONTROL_CGROUP_NAME);
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancel);
        let worker = thread::Builder::new()
            .name(THREAD_WORKLOAD_BOOTSTRAP.to_owned())
            .spawn(move || {
                serve_workload_placement(
                    listener,
                    placement,
                    expected_uid,
                    &expected_cgroup,
                    &worker_cancel,
                );
            })
            .map_err(|error| {
                ProcessContainmentError::new("start workload placement bootstrap worker", error)
            })?;
        Ok(WorkloadPlacementBootstrap {
            endpoint,
            cancel,
            worker: Some(worker),
        })
    }

    fn cleanup(self, mode: ProcessContainmentCleanupMode) -> Result<(), ProcessContainmentError> {
        let started = Instant::now();
        let CgroupGuard {
            group_name,
            group_path,
            outer_placement,
            workload_placement,
            create_elapsed,
        } = self;
        drop(outer_placement);
        drop(workload_placement);

        log_resource_events(&group_name, &group_path.join(WORKLOAD_CGROUP_NAME));

        let result = cleanup_cgroup(&group_path, mode);
        match result {
            Ok(report) => {
                // Healthy exec cleanup is a hot path. Emit diagnostics
                // only when containment had work beyond removing an empty leaf.
                if report.descendants_observed
                    || report.cgroup_kill_used
                    || report.graceful_errors > 0
                {
                    log(
                        "INFO",
                        &format!(
                            "exec process containment cleaned group={group_name} mode={mode:?} descendants_observed={} cgroup_kill_used={} initial_members={} graceful_errors={} create_us={} cleanup_ms={}",
                            report.descendants_observed,
                            report.cgroup_kill_used,
                            report.initial_members,
                            report.graceful_errors,
                            create_elapsed.as_micros(),
                            started.elapsed().as_millis()
                        ),
                    );
                }
                Ok(())
            }
            Err(error) => {
                log(
                    "ERROR",
                    &format!(
                        "exec process containment cleanup failed group={group_name} mode={mode:?} stage={} error={}",
                        error.stage, error.source
                    ),
                );
                Err(error)
            }
        }
    }
}

fn workload_resource_policy() -> Result<WorkloadResourcePolicy, ProcessContainmentError> {
    WorkloadResourcePolicy::for_current_guest_capacity().map_err(|message| {
        ProcessContainmentError::new("derive workload resource policy", io::Error::other(message))
    })
}

fn enable_required_controllers(group_path: &Path) -> Result<(), ProcessContainmentError> {
    fs::write(
        group_path.join(CGROUP_SUBTREE_CONTROL_FILE),
        REQUIRED_CGROUP_SUBTREE_CONTROL.as_bytes(),
    )
    .map_err(|error| ProcessContainmentError::new("enable cgroup controllers", error))?;
    let enabled = fs::read_to_string(group_path.join(CGROUP_SUBTREE_CONTROL_FILE))
        .map_err(|error| ProcessContainmentError::new("read cgroup controllers", error))?;
    let enabled = enabled
        .split_ascii_whitespace()
        .map(|controller| controller.trim_start_matches('+'))
        .collect::<HashSet<_>>();
    if REQUIRED_CGROUP_CONTROLLERS
        .into_iter()
        .all(|controller| enabled.contains(controller))
    {
        return Ok(());
    }
    Err(ProcessContainmentError::new(
        "verify cgroup controllers",
        io::Error::other("operation cgroup is missing a required controller"),
    ))
}

fn configure_resource_policy(
    group_path: &Path,
    control_path: &Path,
    workload_path: &Path,
    trusted_control: bool,
    policy: WorkloadResourcePolicy,
) -> Result<(), ProcessContainmentError> {
    write_cgroup_value(
        workload_path,
        CPU_MAX_FILE,
        &format!("{} {}", policy.cpu_quota_us, policy.cpu_period_us),
        "configure workload cpu.max",
    )?;
    write_cgroup_value(
        workload_path,
        MEMORY_HIGH_FILE,
        &policy.memory_high_bytes.to_string(),
        "configure workload memory.high",
    )?;
    write_cgroup_value(
        workload_path,
        MEMORY_MAX_FILE,
        &policy.memory_max_bytes.to_string(),
        "configure workload memory.max",
    )?;
    write_cgroup_value(
        workload_path,
        MEMORY_OOM_GROUP_FILE,
        "1",
        "configure workload memory.oom.group",
    )?;
    write_cgroup_value(
        workload_path,
        PIDS_MAX_FILE,
        policy.pids_max,
        "configure workload pids.max",
    )?;

    if trusted_control {
        let weight = CONTROL_CPU_WEIGHT.to_string();
        write_cgroup_value(
            group_path,
            CPU_WEIGHT_FILE,
            &weight,
            "prioritize controlled operation CPU",
        )?;
        write_cgroup_value(
            control_path,
            CPU_WEIGHT_FILE,
            &weight,
            "prioritize Guest Agent CPU",
        )?;
        write_cgroup_value(
            group_path,
            MEMORY_MIN_FILE,
            &policy.control_memory_min_bytes.to_string(),
            "protect controlled operation memory",
        )?;
        write_cgroup_value(
            control_path,
            MEMORY_MIN_FILE,
            &policy.control_memory_min_bytes.to_string(),
            "protect Guest Agent memory",
        )?;
    }
    Ok(())
}

fn write_cgroup_value(
    group_path: &Path,
    filename: &str,
    value: &str,
    stage: &'static str,
) -> Result<(), ProcessContainmentError> {
    fs::write(group_path.join(filename), value.as_bytes())
        .map_err(|error| ProcessContainmentError::new(stage, error))
}

fn open_placement(
    group_path: &Path,
    stage: &'static str,
) -> Result<OwnedFd, ProcessContainmentError> {
    OpenOptions::new()
        .write(true)
        .open(group_path.join(CGROUP_PROCS_FILE))
        .map(Into::into)
        .map_err(|error| ProcessContainmentError::new(stage, error))
}

#[derive(Debug, Default)]
struct ResourceEvents {
    cpu_nr_throttled: u64,
    cpu_throttled_usec: u64,
    memory_high: u64,
    memory_max: u64,
    memory_oom: u64,
    memory_oom_kill: u64,
    memory_oom_group_kill: u64,
    pids_max: u64,
}

fn log_resource_events(group_name: &str, workload_path: &Path) {
    let events = match read_resource_events(workload_path) {
        Ok(events) => events,
        Err(error) => {
            log(
                "WARN",
                &format!(
                    "exec workload resource diagnostics unavailable group={group_name} error={error}"
                ),
            );
            return;
        }
    };
    if events.memory_max > 0
        || events.memory_oom > 0
        || events.memory_oom_kill > 0
        || events.memory_oom_group_kill > 0
        || events.pids_max > 0
    {
        log(
            "WARN",
            &format!(
                "exec workload hard resource limit reached group={group_name} memory_max={} memory_oom={} memory_oom_kill={} memory_oom_group_kill={} pids_max={}",
                events.memory_max,
                events.memory_oom,
                events.memory_oom_kill,
                events.memory_oom_group_kill,
                events.pids_max
            ),
        );
    }
    if events.cpu_throttled_usec >= MATERIAL_CPU_THROTTLED_USEC || events.memory_high > 0 {
        log(
            "INFO",
            &format!(
                "exec workload resource pressure observed group={group_name} cpu_nr_throttled={} cpu_throttled_usec={} memory_high={}",
                events.cpu_nr_throttled, events.cpu_throttled_usec, events.memory_high
            ),
        );
    }
}

fn read_resource_events(workload_path: &Path) -> io::Result<ResourceEvents> {
    let cpu = read_key_value_file(&workload_path.join(CPU_STAT_FILE))?;
    let memory = read_key_value_file(&workload_path.join(MEMORY_EVENTS_FILE))?;
    let pids = read_key_value_file(&workload_path.join(PIDS_EVENTS_FILE))?;
    Ok(ResourceEvents {
        cpu_nr_throttled: value_or_zero(&cpu, "nr_throttled"),
        cpu_throttled_usec: value_or_zero(&cpu, "throttled_usec"),
        memory_high: value_or_zero(&memory, "high"),
        memory_max: value_or_zero(&memory, "max"),
        memory_oom: value_or_zero(&memory, "oom"),
        memory_oom_kill: value_or_zero(&memory, "oom_kill"),
        memory_oom_group_kill: value_or_zero(&memory, "oom_group_kill"),
        pids_max: value_or_zero(&pids, "max"),
    })
}

fn read_key_value_file(path: &Path) -> io::Result<std::collections::HashMap<String, u64>> {
    fs::read_to_string(path)?
        .lines()
        .map(|line| {
            let (key, value) = line.split_once(' ').ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "invalid cgroup event line")
            })?;
            let value = value
                .parse::<u64>()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            Ok((key.to_string(), value))
        })
        .collect()
}

fn value_or_zero(values: &std::collections::HashMap<String, u64>, key: &str) -> u64 {
    values.get(key).copied().unwrap_or(0)
}

#[derive(Debug)]
struct CleanupReport {
    descendants_observed: bool,
    cgroup_kill_used: bool,
    initial_members: usize,
    graceful_errors: usize,
}

fn cleanup_cgroup(
    group_path: &Path,
    mode: ProcessContainmentCleanupMode,
) -> Result<CleanupReport, ProcessContainmentError> {
    let descendants_observed = match read_populated(group_path) {
        Ok(populated) => populated,
        Err(error) => {
            log(
                "WARN",
                &format!(
                    "exec process containment cleanup could not read initial populated state mode={mode:?} error={error}"
                ),
            );
            true
        }
    };
    let mut cgroup_kill_used = false;
    let mut initial_members = 0;
    let mut graceful_errors = 0;

    if descendants_observed && mode == ProcessContainmentCleanupMode::Graceful {
        for leaf_path in cgroup_leaf_paths(group_path) {
            match read_member_pids(&leaf_path) {
                Ok(pids) => {
                    initial_members += pids.len();
                    graceful_errors += signal_term(&leaf_path, &pids);
                }
                Err(error) => {
                    graceful_errors += 1;
                    log(
                        "WARN",
                        &format!(
                            "exec process containment graceful enumeration failed leaf={} error={error}",
                            leaf_path.display()
                        ),
                    );
                }
            }
        }

        if let Err(error) = wait_until_empty(group_path, EXEC_PROCESS_CONTAINMENT_TERM_GRACE) {
            log(
                "WARN",
                &format!(
                    "exec process containment graceful wait could not read populated state error={error}"
                ),
            );
        }
    }

    let remains_populated = if mode == ProcessContainmentCleanupMode::Forced {
        true
    } else {
        match read_populated(group_path) {
            Ok(populated) => populated,
            Err(error) => {
                log(
                    "WARN",
                    &format!(
                        "exec process containment cleanup could not confirm empty state before cgroup.kill error={error}"
                    ),
                );
                true
            }
        }
    };
    if remains_populated {
        fs::write(group_path.join(CGROUP_KILL_FILE), b"1")
            .map_err(|error| ProcessContainmentError::new("write cgroup.kill", error))?;
        cgroup_kill_used = true;
        if !wait_until_empty(group_path, EXEC_PROCESS_CONTAINMENT_KILL_EMPTY_TIMEOUT)? {
            return Err(ProcessContainmentError::new(
                "wait for cgroup.kill",
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "cgroup remained populated after cgroup.kill",
                ),
            ));
        }
    }

    remove_cgroup_hierarchy(group_path)?;
    Ok(CleanupReport {
        descendants_observed,
        cgroup_kill_used,
        initial_members,
        graceful_errors,
    })
}

fn install_child_placement(command: &mut Command, placement: OwnedFd) {
    // SAFETY: the closure performs only raw writes and fcntl calls on already
    // open descriptors. These operations are async-signal-safe between fork
    // and exec.
    unsafe {
        command.pre_exec(move || {
            write_self_to_cgroup(placement.as_raw_fd())?;
            Ok(())
        });
    }
}

fn install_process_inspection_denial(command: &mut Command) {
    // SAFETY: the closure performs one async-signal-safe prctl call in the
    // child after its credential transition and before exec.
    unsafe {
        command.pre_exec(deny_unprivileged_process_inspection);
    }
}

fn serve_workload_placement(
    listener: std::os::unix::net::UnixListener,
    placement: OwnedFd,
    expected_uid: libc::uid_t,
    expected_cgroup: &Path,
    cancel: &AtomicBool,
) {
    while !cancel.load(Ordering::Acquire) {
        let stream = match process_control_ipc::accept_with_timeout(
            &listener,
            WORKLOAD_BOOTSTRAP_ACCEPT_POLL,
        ) {
            Ok(stream) => stream,
            Err(error) if error.kind() == io::ErrorKind::TimedOut => continue,
            Err(error) => {
                log(
                    "WARN",
                    &format!("workload placement bootstrap accept failed: {error}"),
                );
                return;
            }
        };

        match workload_bootstrap_peer_matches(&stream, expected_uid, expected_cgroup) {
            Ok(true) => {
                if let Err(error) =
                    process_control_ipc::send_workload_placement(&stream, placement.as_fd())
                {
                    log(
                        "WARN",
                        &format!("workload placement descriptor send failed: {error}"),
                    );
                }
                return;
            }
            Ok(false) => {
                log(
                    "WARN",
                    "workload placement bootstrap rejected an unexpected peer",
                );
            }
            Err(error) => {
                log(
                    "WARN",
                    &format!("workload placement bootstrap peer validation failed: {error}"),
                );
            }
        }
    }
}

fn workload_bootstrap_peer_matches(
    stream: &std::os::unix::net::UnixStream,
    expected_uid: libc::uid_t,
    expected_cgroup: &Path,
) -> io::Result<bool> {
    // SAFETY: zeroed ucred is a valid output buffer for SO_PEERCRED.
    let mut credentials = unsafe { std::mem::zeroed::<libc::ucred>() };
    let mut credentials_len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: stream is a connected Unix socket and the output pointers refer
    // to a correctly sized ucred buffer and socklen_t.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::addr_of_mut!(credentials).cast(),
            std::ptr::addr_of_mut!(credentials_len),
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if credentials_len as usize != std::mem::size_of::<libc::ucred>()
        || credentials.pid <= 0
        || credentials.uid != expected_uid
    {
        return Ok(false);
    }

    let cgroup = fs::read_to_string(format!("/proc/{}/cgroup", credentials.pid));
    let cgroup = match cgroup {
        Ok(cgroup) => cgroup,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let relative = cgroup.lines().find_map(|line| line.strip_prefix("0::"));
    let Some(relative) = relative.and_then(|path| path.strip_prefix('/')) else {
        return Ok(false);
    };
    Ok(Path::new(CGROUP_V2_MOUNT_PATH).join(relative) == expected_cgroup)
}

fn deny_unprivileged_process_inspection() -> io::Result<()> {
    // SAFETY: PR_SET_DUMPABLE changes only the calling child between fork and
    // exec and does not access shared userspace state.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn write_self_to_cgroup(fd: RawFd) -> io::Result<()> {
    loop {
        // SAFETY: `fd` is open for writing and the one-byte buffer is valid for
        // the duration of the call.
        let written = unsafe { libc::write(fd, b"0".as_ptr().cast(), 1) };
        if written == 1 {
            return Ok(());
        }
        if written < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
}

fn read_populated(group_path: &Path) -> Result<bool, ProcessContainmentError> {
    let content = fs::read_to_string(group_path.join(CGROUP_EVENTS_FILE))
        .map_err(|error| ProcessContainmentError::new("read cgroup.events", error))?;
    parse_populated(&content).ok_or_else(|| {
        ProcessContainmentError::new(
            "parse cgroup.events",
            io::Error::new(
                io::ErrorKind::InvalidData,
                "cgroup.events is missing populated state",
            ),
        )
    })
}

fn parse_populated(content: &str) -> Option<bool> {
    content.lines().find_map(|line| {
        let (key, value) = line.split_once(' ')?;
        if key != "populated" {
            return None;
        }
        match value {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        }
    })
}

fn read_member_pids(group_path: &Path) -> io::Result<Vec<libc::pid_t>> {
    let content = fs::read_to_string(group_path.join(CGROUP_PROCS_FILE))?;
    content
        .lines()
        .map(|line| {
            let pid = line
                .parse::<libc::pid_t>()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            if pid <= 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "cgroup.procs contains a non-positive pid",
                ));
            }
            Ok(pid)
        })
        .collect()
}

fn signal_term(group_path: &Path, pids: &[libc::pid_t]) -> usize {
    let mut errors = 0;
    let mut candidates = Vec::with_capacity(pids.len());
    for &pid in pids {
        let pidfd = match open_pidfd(pid) {
            Ok(Some(pidfd)) => pidfd,
            Ok(None) => continue,
            Err(_) => {
                errors += 1;
                continue;
            }
        };
        candidates.push((pid, pidfd));
    }
    if candidates.is_empty() {
        return errors;
    }

    // Opening a pidfd stabilizes identity only from that point onward. Recheck
    // membership so a PID recycled after the first enumeration is never
    // signalled through a pidfd opened for an unrelated process.
    let current_members = match read_member_pids(group_path) {
        Ok(pids) => pids.into_iter().collect::<HashSet<_>>(),
        Err(_) => return errors + 1,
    };
    for (pid, pidfd) in candidates {
        if !current_members.contains(&pid) {
            continue;
        }
        if let Err(error) = signal_pidfd(&pidfd, libc::SIGTERM)
            && error.raw_os_error() != Some(libc::ESRCH)
        {
            errors += 1;
        }
    }
    errors
}

fn open_pidfd(pid: libc::pid_t) -> io::Result<Option<OwnedFd>> {
    // SAFETY: `pidfd_open` does not dereference user pointers and the PID came
    // from the kernel-owned cgroup.procs file.
    let result = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        return Err(error);
    }
    let fd = RawFd::try_from(result)
        .map_err(|_| io::Error::other("pidfd_open returned an invalid file descriptor"))?;
    // SAFETY: `fd` is a new descriptor returned by pidfd_open.
    Ok(Some(unsafe { OwnedFd::from_raw_fd(fd) }))
}

fn signal_pidfd(pidfd: &OwnedFd, signal: libc::c_int) -> io::Result<()> {
    // SAFETY: `pidfd` is valid, signal is a standard signal number, and a null
    // siginfo pointer requests ordinary signal semantics.
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            pidfd.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn wait_until_empty(group_path: &Path, timeout: Duration) -> Result<bool, ProcessContainmentError> {
    let deadline = Instant::now() + timeout;
    loop {
        if !read_populated(group_path)? {
            return Ok(true);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        thread::sleep(remaining.min(POLL_INTERVAL));
    }
}

fn remove_empty_cgroup_until(
    group_path: &Path,
    deadline: Instant,
) -> Result<(), ProcessContainmentError> {
    #[cfg(test)]
    remove_test_cgroup_interface_files(group_path);
    loop {
        match fs::remove_dir(group_path) {
            Ok(()) => return Ok(()),
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::EBUSY) | Some(libc::ENOTEMPTY)
                ) && Instant::now() < deadline =>
            {
                let remaining = deadline.saturating_duration_since(Instant::now());
                thread::sleep(remaining.min(POLL_INTERVAL));
            }
            Err(error) => {
                return Err(ProcessContainmentError::new("remove cgroup", error));
            }
        }
    }
}

#[cfg(test)]
fn remove_test_cgroup_interface_files(group_path: &Path) {
    for filename in [
        CGROUP_SUBTREE_CONTROL_FILE,
        CPU_MAX_FILE,
        CPU_WEIGHT_FILE,
        MEMORY_HIGH_FILE,
        MEMORY_MAX_FILE,
        MEMORY_MIN_FILE,
        MEMORY_OOM_GROUP_FILE,
        PIDS_MAX_FILE,
    ] {
        let _ = fs::remove_file(group_path.join(filename));
    }
}

fn cgroup_leaf_paths(group_path: &Path) -> [PathBuf; 2] {
    [
        group_path.join(CONTROL_CGROUP_NAME),
        group_path.join(WORKLOAD_CGROUP_NAME),
    ]
}

fn remove_cgroup_hierarchy(group_path: &Path) -> Result<(), ProcessContainmentError> {
    let deadline = Instant::now() + EXEC_PROCESS_CONTAINMENT_REMOVE_TIMEOUT;
    for leaf_path in cgroup_leaf_paths(group_path) {
        match remove_empty_cgroup_until(&leaf_path, deadline) {
            Ok(()) => {}
            Err(error) if error.source.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    remove_empty_cgroup_until(group_path, deadline)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
    use std::process::{Child, Stdio};

    struct ChildGuard(Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn parses_recursive_populated_state() {
        assert_eq!(parse_populated("populated 0\nfrozen 0\n"), Some(false));
        assert_eq!(parse_populated("populated 1\nfrozen 0\n"), Some(true));
        assert_eq!(parse_populated("frozen 0\n"), None);
        assert_eq!(parse_populated("populated 2\n"), None);
    }

    #[test]
    fn quiesce_accepts_empty_exec_cgroup_base() {
        let base = tempfile::tempdir().unwrap();
        fs::write(base.path().join(CGROUP_EVENTS_FILE), b"populated 0\n").unwrap();

        verify_exec_process_containment_empty_in(base.path()).unwrap();
    }

    #[test]
    fn quiesce_rejects_stale_exec_cgroup_leaf() {
        let base = tempfile::tempdir().unwrap();
        fs::write(base.path().join(CGROUP_EVENTS_FILE), b"populated 0\n").unwrap();
        fs::create_dir(base.path().join("exec-stale")).unwrap();

        let error = verify_exec_process_containment_empty_in(base.path())
            .expect_err("stale operation leaf must reject quiesce");

        assert_eq!(error.stage, "verify exec cgroup empty");
    }

    #[test]
    fn quiesce_rejects_populated_exec_cgroup_base() {
        let base = tempfile::tempdir().unwrap();
        fs::write(base.path().join(CGROUP_EVENTS_FILE), b"populated 1\n").unwrap();

        let error = verify_exec_process_containment_empty_in(base.path())
            .expect_err("populated containment must reject quiesce");

        assert_eq!(error.stage, "verify exec cgroup empty");
    }

    #[test]
    fn forced_cleanup_attempts_cgroup_kill_when_events_are_unreadable() {
        let group = tempfile::tempdir().unwrap();
        let kill_path = group.path().join(CGROUP_KILL_FILE);
        fs::write(&kill_path, b"").unwrap();

        let error = cleanup_cgroup(group.path(), ProcessContainmentCleanupMode::Forced)
            .expect_err("missing cgroup.events should leave cleanup unproven");

        assert_eq!(error.stage, "read cgroup.events");
        assert_eq!(fs::read(&kill_path).unwrap(), b"1");
    }

    #[test]
    fn graceful_cleanup_attempts_cgroup_kill_when_events_are_unreadable() {
        let group = tempfile::tempdir().unwrap();
        let kill_path = group.path().join(CGROUP_KILL_FILE);
        fs::write(&kill_path, b"").unwrap();

        let error = cleanup_cgroup(group.path(), ProcessContainmentCleanupMode::Graceful)
            .expect_err("missing cgroup.events should leave cleanup unproven");

        assert_eq!(error.stage, "read cgroup.events");
        assert_eq!(fs::read(&kill_path).unwrap(), b"1");
    }

    #[test]
    fn pre_exec_writes_child_into_open_placement_file() {
        let mut placement = tempfile::tempfile().unwrap();
        let child_fd: OwnedFd = placement.try_clone().unwrap().into();
        let mut command = Command::new("/bin/true");
        command.stdout(Stdio::null()).stderr(Stdio::null());
        install_child_placement(&mut command, child_fd);

        let status = command.status().unwrap();

        assert!(status.success());
        placement.seek(SeekFrom::Start(0)).unwrap();
        let mut content = String::new();
        placement.read_to_string(&mut content).unwrap();
        assert_eq!(content, "0");
    }

    #[test]
    fn workload_bootstrap_authenticates_peer_uid_and_cgroup() {
        let (peer, _server) = std::os::unix::net::UnixStream::pair().unwrap();
        // SAFETY: geteuid is a simple scalar getter with no preconditions.
        let uid = unsafe { libc::geteuid() };
        let current_cgroup = fs::read_to_string("/proc/self/cgroup").unwrap();
        let relative = current_cgroup
            .lines()
            .find_map(|line| line.strip_prefix("0::/"))
            .unwrap();
        let expected = Path::new(CGROUP_V2_MOUNT_PATH).join(relative);

        assert!(workload_bootstrap_peer_matches(&peer, uid, &expected).unwrap());
        assert!(!workload_bootstrap_peer_matches(&peer, uid.wrapping_add(1), &expected).unwrap());
        assert!(
            !workload_bootstrap_peer_matches(&peer, uid, &expected.join("not-the-peer-cgroup"))
                .unwrap()
        );
    }

    #[test]
    fn partial_creation_failure_removes_operation_cgroup() {
        let base = tempfile::tempdir().unwrap();

        let policy =
            WorkloadResourcePolicy::for_guest_capacity(2, u64::from(4096_u32) * 1024 * 1024)
                .unwrap();
        let result = CgroupGuard::create_in(base.path(), 17, false, policy);
        let Err(error) = result else {
            panic!("placement-file open unexpectedly succeeded");
        };

        assert_eq!(error.stage, "open outer cgroup.procs");
        assert_eq!(error.source.kind(), io::ErrorKind::NotFound);
        assert!(fs::read_dir(base.path()).unwrap().next().is_none());
    }

    #[test]
    fn spawn_failure_removes_owned_operation_cgroup() {
        let base = tempfile::tempdir().unwrap();
        let group_path = base.path().join("exec-spawn-failure");
        fs::create_dir(&group_path).unwrap();
        let containment = ExecProcessContainment {
            backend: ContainmentBackend::TestDirectory(group_path.clone()),
        };

        let result = crate::shell_command::spawn_shell_command_with_pipes(
            "bad\0command",
            &[],
            false,
            false,
            containment,
        );
        let Err(error) = result else {
            panic!("invalid command unexpectedly spawned");
        };

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(!group_path.exists());
    }

    #[test]
    fn spawn_failure_preserves_primary_error_when_cleanup_fails() {
        let base = tempfile::tempdir().unwrap();
        let group_path = base.path().join("exec-cleanup-failure");
        fs::create_dir(&group_path).unwrap();
        fs::write(group_path.join("blocker"), b"keep directory non-empty").unwrap();
        let containment = ExecProcessContainment {
            backend: ContainmentBackend::TestDirectory(group_path.clone()),
        };

        let result = crate::shell_command::spawn_shell_command_with_pipes(
            "bad\0command",
            &[],
            false,
            false,
            containment,
        );
        let Err(error) = result else {
            panic!("invalid command unexpectedly spawned");
        };

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(group_path.is_dir());
    }

    #[test]
    fn graceful_signal_rechecks_membership_after_opening_pidfd() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join(CGROUP_PROCS_FILE), "").unwrap();
        let mut child = ChildGuard(
            Command::new("/bin/sh")
                .arg("-c")
                .arg(
                    "trap 'printf \"term\\n\"; exit 42' TERM; \
                     printf 'ready\\n'; \
                     while IFS= read -r line; do printf '%s\\n' \"$line\"; done",
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let enumerated_pid = libc::pid_t::try_from(child.0.id()).unwrap();
        let mut stdout = BufReader::new(child.0.stdout.take().unwrap());
        let mut response = String::new();
        stdout.read_line(&mut response).unwrap();
        assert_eq!(response, "ready\n");

        let errors = signal_term(directory.path(), &[enumerated_pid]);
        writeln!(child.0.stdin.as_mut().unwrap(), "probe").unwrap();
        response.clear();
        stdout.read_line(&mut response).unwrap();

        assert_eq!(errors, 0);
        assert_eq!(response, "probe\n");
    }
}
