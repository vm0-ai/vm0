use std::io::ErrorKind;

use nbd_cow::BLOCK_SIZE;
use nbd_cow::cow::CowLayer;
use nbd_cow::cow_io::{CowIo, CowIoStatus};
use nbd_cow::error::NbdCowError;
use tempfile::NamedTempFile;

type TestResult<T> = Result<T, Box<dyn std::error::Error>>;

fn create_cow() -> TestResult<(NamedTempFile, NamedTempFile, CowLayer)> {
    let base = NamedTempFile::new()?;
    let cow_file = NamedTempFile::new()?;
    let size = (3 * BLOCK_SIZE) as u64;
    base.as_file().set_len(size)?;
    let cow = CowLayer::new(
        base.path(),
        cow_file.path(),
        size,
        BLOCK_SIZE,
        2 * BLOCK_SIZE,
    )?;
    Ok((base, cow_file, cow))
}

fn expected_data(preexisting_block: bool) -> Vec<u8> {
    let mut data = vec![if preexisting_block { 0xBB } else { 0 }; BLOCK_SIZE];
    data.extend_from_slice(&vec![0xAA; BLOCK_SIZE]);
    data
}

fn check_sync_write_error_accounting(preexisting_block: bool) -> TestResult<()> {
    let (base, cow_file, mut cow) = create_cow()?;
    if preexisting_block {
        assert!(!cow.write(0, &vec![0xBB; BLOCK_SIZE])?);
    }
    // Block 1 can be inserted, but the partial write to block 2 must read past EOF.
    base.as_file().set_len((2 * BLOCK_SIZE) as u64)?;
    let result = cow.write(BLOCK_SIZE as u64, &vec![0xAA; BLOCK_SIZE + 1]);
    assert!(
        matches!(&result, Err(NbdCowError::Io(error)) if error.kind() == ErrorKind::UnexpectedEof)
    );

    let retained_blocks = 1 + usize::from(preexisting_block);
    assert_eq!(cow.buffered_block_count(), retained_blocks);
    assert_eq!(cow.buffer_bytes(), retained_blocks * BLOCK_SIZE);
    assert_eq!(cow.dirty_block_count(), 0);
    let expected = expected_data(preexisting_block);
    let mut data = vec![0; expected.len()];
    cow.read(0, &mut data)?;
    assert_eq!(data, expected);

    // An overwrite adds no block; a successful write still signals at the threshold.
    assert_eq!(cow.write(BLOCK_SIZE as u64, &[0xAA])?, preexisting_block);
    assert_eq!(cow.buffer_bytes(), retained_blocks * BLOCK_SIZE);
    cow.sync()?;
    assert_eq!(cow.buffered_block_count(), 0);
    assert_eq!(cow.buffer_bytes(), 0);
    assert_eq!(cow.dirty_block_count(), retained_blocks);
    assert_eq!(std::fs::read(cow_file.path())?, expected);
    cow.read(0, &mut data)?;
    assert_eq!(data, expected);
    Ok(())
}

async fn check_async_write_error_accounting(preexisting_block: bool) -> TestResult<()> {
    let (base, cow_file, cow) = create_cow()?;
    let cow = CowIo::new(cow);
    if preexisting_block {
        cow.write(0, vec![0xBB; BLOCK_SIZE]).await?;
    }
    base.as_file().set_len((2 * BLOCK_SIZE) as u64)?;
    let result = cow
        .write(BLOCK_SIZE as u64, vec![0xAA; BLOCK_SIZE + 1])
        .await;
    assert!(
        matches!(&result, Err(NbdCowError::Io(error)) if error.kind() == ErrorKind::UnexpectedEof)
    );

    // A failed write retains its blocks without triggering a threshold flush.
    let retained_blocks = 1 + usize::from(preexisting_block);
    assert_eq!(
        cow.status().await?,
        CowIoStatus {
            dirty_blocks: 0,
            buffered_blocks: retained_blocks,
            buffer_bytes: retained_blocks * BLOCK_SIZE,
        }
    );
    let expected = expected_data(preexisting_block);
    assert_eq!(cow.read(0, vec![0; expected.len()]).await?, expected);

    cow.sync().await?;
    assert_eq!(
        cow.status().await?,
        CowIoStatus {
            dirty_blocks: retained_blocks,
            buffered_blocks: 0,
            buffer_bytes: 0,
        }
    );
    assert_eq!(std::fs::read(cow_file.path())?, expected);
    assert_eq!(cow.read(0, vec![0; expected.len()]).await?, expected);
    Ok(())
}

#[test]
fn sync_write_error_accounts_for_newly_buffered_block() -> TestResult<()> {
    check_sync_write_error_accounting(false)
}

#[test]
fn sync_write_error_accounts_for_preexisting_and_new_blocks() -> TestResult<()> {
    check_sync_write_error_accounting(true)
}

#[tokio::test]
async fn async_write_error_accounts_for_newly_buffered_block() -> TestResult<()> {
    check_async_write_error_accounting(false).await
}

#[tokio::test]
async fn async_write_error_accounts_for_preexisting_and_new_blocks() -> TestResult<()> {
    check_async_write_error_accounting(true).await
}
