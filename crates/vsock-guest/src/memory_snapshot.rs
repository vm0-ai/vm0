use std::io;
use std::path::{Path, PathBuf};

use vsock_proto::MemorySnapshot;

const MEMINFO_PATH: &str = "/proc/meminfo";
const KIB: u64 = 1024;

pub(crate) enum MeminfoSource {
    Production,
    Test(PathBuf),
}

impl MeminfoSource {
    pub(crate) fn production() -> Self {
        Self::Production
    }

    pub(crate) fn for_test(path: PathBuf) -> Self {
        Self::Test(path)
    }

    pub(crate) fn read_memory_snapshot(&self) -> io::Result<MemorySnapshot> {
        let meminfo = std::fs::read_to_string(self.path())?;
        parse_memory_snapshot(&meminfo)
    }

    fn path(&self) -> &Path {
        match self {
            Self::Production => Path::new(MEMINFO_PATH),
            Self::Test(path) => path,
        }
    }
}

#[derive(Default)]
struct MemorySnapshotFields {
    mem_total_bytes: Option<u64>,
    mem_free_bytes: Option<u64>,
    mem_available_bytes: Option<u64>,
    buffers_bytes: Option<u64>,
    cached_bytes: Option<u64>,
    anon_pages_bytes: Option<u64>,
    mapped_bytes: Option<u64>,
    dirty_bytes: Option<u64>,
    writeback_bytes: Option<u64>,
    shmem_bytes: Option<u64>,
    slab_bytes: Option<u64>,
    slab_reclaimable_bytes: Option<u64>,
    slab_unreclaimable_bytes: Option<u64>,
    unevictable_bytes: Option<u64>,
    kernel_stack_bytes: Option<u64>,
    page_tables_bytes: Option<u64>,
    swap_total_bytes: Option<u64>,
    swap_free_bytes: Option<u64>,
}

fn parse_memory_snapshot(meminfo: &str) -> io::Result<MemorySnapshot> {
    let mut fields = MemorySnapshotFields::default();
    for line in meminfo.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let destination = match name {
            "MemTotal" => &mut fields.mem_total_bytes,
            "MemFree" => &mut fields.mem_free_bytes,
            "MemAvailable" => &mut fields.mem_available_bytes,
            "Buffers" => &mut fields.buffers_bytes,
            "Cached" => &mut fields.cached_bytes,
            "AnonPages" => &mut fields.anon_pages_bytes,
            "Mapped" => &mut fields.mapped_bytes,
            "Dirty" => &mut fields.dirty_bytes,
            "Writeback" => &mut fields.writeback_bytes,
            "Shmem" => &mut fields.shmem_bytes,
            "Slab" => &mut fields.slab_bytes,
            "SReclaimable" => &mut fields.slab_reclaimable_bytes,
            "SUnreclaim" => &mut fields.slab_unreclaimable_bytes,
            "Unevictable" => &mut fields.unevictable_bytes,
            "KernelStack" => &mut fields.kernel_stack_bytes,
            "PageTables" => &mut fields.page_tables_bytes,
            "SwapTotal" => &mut fields.swap_total_bytes,
            "SwapFree" => &mut fields.swap_free_bytes,
            _ => continue,
        };
        *destination = Some(parse_kib_value(name, value)?);
    }

    Ok(MemorySnapshot {
        mem_total_bytes: required(fields.mem_total_bytes, "MemTotal")?,
        mem_free_bytes: required(fields.mem_free_bytes, "MemFree")?,
        mem_available_bytes: required(fields.mem_available_bytes, "MemAvailable")?,
        buffers_bytes: required(fields.buffers_bytes, "Buffers")?,
        cached_bytes: required(fields.cached_bytes, "Cached")?,
        anon_pages_bytes: required(fields.anon_pages_bytes, "AnonPages")?,
        mapped_bytes: required(fields.mapped_bytes, "Mapped")?,
        dirty_bytes: required(fields.dirty_bytes, "Dirty")?,
        writeback_bytes: required(fields.writeback_bytes, "Writeback")?,
        shmem_bytes: required(fields.shmem_bytes, "Shmem")?,
        slab_bytes: required(fields.slab_bytes, "Slab")?,
        slab_reclaimable_bytes: required(fields.slab_reclaimable_bytes, "SReclaimable")?,
        slab_unreclaimable_bytes: required(fields.slab_unreclaimable_bytes, "SUnreclaim")?,
        unevictable_bytes: required(fields.unevictable_bytes, "Unevictable")?,
        kernel_stack_bytes: required(fields.kernel_stack_bytes, "KernelStack")?,
        page_tables_bytes: required(fields.page_tables_bytes, "PageTables")?,
        swap_total_bytes: required(fields.swap_total_bytes, "SwapTotal")?,
        swap_free_bytes: required(fields.swap_free_bytes, "SwapFree")?,
    })
}

fn parse_kib_value(name: &str, value: &str) -> io::Result<u64> {
    let mut parts = value.split_whitespace();
    let kib = parts
        .next()
        .ok_or_else(|| invalid_meminfo(format!("{name} has no value")))?
        .parse::<u64>()
        .map_err(|_| invalid_meminfo(format!("{name} has an invalid value")))?;
    if parts.next() != Some("kB") || parts.next().is_some() {
        return Err(invalid_meminfo(format!("{name} has an invalid unit")));
    }
    kib.checked_mul(KIB)
        .ok_or_else(|| invalid_meminfo(format!("{name} byte value overflowed")))
}

fn required(value: Option<u64>, name: &str) -> io::Result<u64> {
    value.ok_or_else(|| invalid_meminfo(format!("{name} is missing")))
}

fn invalid_meminfo(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
