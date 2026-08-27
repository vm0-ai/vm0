use super::super::*;

#[test]
fn exec_agent_ready_round_trips_fixed_component_timing() {
    let timing = ExecAgentReadyTiming {
        containment_create_us: 1,
        placement_broker_setup_us: 2,
        shell_spawn_us: 3,
        bootstrap_ready_wait_us: 4,
    };

    let payload = encode_exec_agent_ready(timing);

    assert_eq!(payload.len(), 16);
    assert_eq!(decode_exec_agent_ready(&payload).unwrap(), timing);
}

#[test]
fn exec_agent_ready_rejects_truncated_and_trailing_payloads() {
    let timing = ExecAgentReadyTiming {
        containment_create_us: 1,
        placement_broker_setup_us: 2,
        shell_spawn_us: 3,
        bootstrap_ready_wait_us: 4,
    };
    let payload = encode_exec_agent_ready(timing);

    assert!(matches!(
        decode_exec_agent_ready(&payload[..15]),
        Err(ProtocolError::InvalidPayload(
            "exec agent ready bootstrap timing truncated"
        ))
    ));
    let mut trailing = payload;
    trailing.push(0);
    assert!(matches!(
        decode_exec_agent_ready(&trailing),
        Err(ProtocolError::InvalidPayload(
            "exec agent ready trailing bytes"
        ))
    ));
}
