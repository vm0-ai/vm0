mod support;

use std::os::unix::fs::MetadataExt as _;
use std::sync::Arc;

use nbd_cow::BLOCK_SIZE;
use nbd_cow::protocol::Command;
use support::dispatch_client::{
    TestResult, assert_error, assert_error_code, assert_success, create_base_file,
    create_cow_with_full_device, create_test_cow, request, spawn_dispatch,
    spawn_dispatch_with_shutdown, wait_for_dispatch,
};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

const OVERSIZED_LENGTH: u32 = 33 * 1024 * 1024;

#[tokio::test]
async fn dispatch_read_write_disconnect() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = Arc::new(RwLock::new(cow));

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let data = client.read(1, 0, BLOCK_SIZE as u32).await?;
    assert!(data.iter().all(|&byte| byte == 0xAA));

    let write_data = vec![0xBB; BLOCK_SIZE];
    let reply = client.write(2, 0, &write_data).await?;
    assert_success(&reply, 2);

    let data = client.read(3, 0, BLOCK_SIZE as u32).await?;
    assert!(data.iter().all(|&byte| byte == 0xBB));

    client.disconnect(4).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_flush_persists_to_cow_file() -> TestResult<()> {
    let base_data = vec![0x00; 2 * BLOCK_SIZE];
    let (_base, cow_file, cow) = create_test_cow(&base_data)?;
    let cow = Arc::new(RwLock::new(cow));

    let (mut client, task, _shutdown) = spawn_dispatch(cow.clone()).await?;

    let write_data = vec![0xCC; BLOCK_SIZE];
    let reply = client.write(1, 0, &write_data).await?;
    assert_success(&reply, 1);

    let reply = client.flush(2).await?;
    assert_success(&reply, 2);

    {
        let cow = cow.read().await;
        assert_eq!(
            cow.buffered_block_count(),
            0,
            "buffer should be empty after flush"
        );
        assert!(
            cow.dirty_block_count() > 0,
            "should have dirty blocks in COW file"
        );
    }

    let cow_meta = std::fs::metadata(cow_file.path())?;
    assert!(
        cow_meta.blocks() > 0,
        "COW file should have allocated blocks after flush"
    );

    client.disconnect(3).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_trim_succeeds() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = Arc::new(RwLock::new(cow));

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let reply = client.trim(1, 0, BLOCK_SIZE as u32).await?;
    assert_success(&reply, 1);

    client.disconnect(2).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_oversized_read_returns_error() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = Arc::new(RwLock::new(cow));

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let oversized_read = request(Command::Read, 1, 0, OVERSIZED_LENGTH);
    client.send_request(&oversized_read).await?;
    let reply = client.read_reply().await?;
    assert_error(&reply, 1);

    let data = client.read(2, 0, BLOCK_SIZE as u32).await?;
    assert!(data.iter().all(|&byte| byte == 0xAA));

    client.disconnect(3).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_oversized_write_discards_and_returns_error() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = Arc::new(RwLock::new(cow));

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let oversized_write = request(Command::Write, 1, 0, OVERSIZED_LENGTH);
    client.send_request(&oversized_write).await?;
    client
        .write_repeated_payload(0xFF, OVERSIZED_LENGTH as usize, 64 * 1024)
        .await?;

    let reply = client.read_reply().await?;
    assert_error(&reply, 1);

    let data = client.read(2, 0, BLOCK_SIZE as u32).await?;
    assert!(data.iter().all(|&byte| byte == 0xAA));

    client.disconnect(3).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_out_of_bounds_read_returns_error() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = Arc::new(RwLock::new(cow));

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let oob_read = request(Command::Read, 1, base_data.len() as u64, BLOCK_SIZE as u32);
    client.send_request(&oob_read).await?;
    let reply = client.read_reply().await?;
    assert_error(&reply, 1);

    let data = client.read(2, 0, BLOCK_SIZE as u32).await?;
    assert!(data.iter().all(|&byte| byte == 0xAA));

    client.disconnect(3).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_out_of_bounds_write_returns_error() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = Arc::new(RwLock::new(cow));

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let write_data = vec![0xFF; BLOCK_SIZE];
    let reply = client.write(1, base_data.len() as u64, &write_data).await?;
    assert_error(&reply, 1);

    let data = client.read(2, 0, BLOCK_SIZE as u32).await?;
    assert!(data.iter().all(|&byte| byte == 0xAA));

    client.disconnect(3).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_write_flush_failure_returns_error() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let base = create_base_file(&base_data)?;
    let cow = Arc::new(RwLock::new(create_cow_with_full_device(&base, BLOCK_SIZE)?));

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let write_data = vec![0xBB; BLOCK_SIZE];
    let reply = client.write(1, 0, &write_data).await?;
    assert_error_code(&reply, 1, libc::EIO as u32);

    drop(client);
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_sync_failure_returns_error() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let base = create_base_file(&base_data)?;
    let cow = Arc::new(RwLock::new(create_cow_with_full_device(
        &base,
        4 * 1024 * 1024,
    )?));

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let write_data = vec![0xBB; BLOCK_SIZE];
    let reply = client.write(1, 0, &write_data).await?;
    assert_success(&reply, 1);

    let reply = client.flush(2).await?;
    assert_error_code(&reply, 2, libc::EIO as u32);

    drop(client);
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dispatch_concurrent_read_write() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = Arc::new(RwLock::new(cow));
    let shutdown = CancellationToken::new();

    let (mut client0, task0) = spawn_dispatch_with_shutdown(cow.clone(), shutdown.clone()).await?;
    let (mut client1, task1) = spawn_dispatch_with_shutdown(cow, shutdown.clone()).await?;

    let first_write = vec![0xBB; BLOCK_SIZE];
    let reply = client0.write(10, 0, &first_write).await?;
    assert_success(&reply, 10);

    let data = client1.read(20, 0, BLOCK_SIZE as u32).await?;
    assert!(
        data.iter().all(|&byte| byte == 0xBB),
        "connection 1 should read data written by connection 0"
    );

    let second_write = vec![0xCC; BLOCK_SIZE];
    let (write_reply, read_data) = tokio::join!(
        client1.write(21, BLOCK_SIZE as u64, &second_write),
        client0.read(11, BLOCK_SIZE as u64, BLOCK_SIZE as u32)
    );

    let write_reply = write_reply?;
    let read_data = read_data?;
    assert_success(&write_reply, 21);
    let byte = read_data[0];
    assert!(
        byte == 0xAA || byte == 0xCC,
        "data should be base (0xAA) or written (0xCC), got {byte:#x}"
    );
    assert!(
        read_data.iter().all(|&candidate| candidate == byte),
        "all bytes in block should be consistent"
    );

    shutdown.cancel();
    wait_for_dispatch(task0).await?;
    wait_for_dispatch(task1).await?;
    Ok(())
}
