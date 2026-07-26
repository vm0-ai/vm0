use std::io::{Seek, SeekFrom, Write};

use guest_session_prune::{
    CLAUDE_COMPACT_GENERATION_MAX_BYTES, ClaudeHistorySelection, select_claude_compact_generation,
};
use serde_json::json;

const SESSION_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOUNDARY_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUMMARY_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

#[test]
fn selects_a_small_generation_from_a_source_above_the_public_guard() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.as_file_mut()
        .set_len(CLAUDE_COMPACT_GENERATION_MAX_BYTES + 1)
        .unwrap();
    file.as_file_mut().seek(SeekFrom::End(0)).unwrap();
    file.write_all(b"\n").unwrap();

    let records = [
        json!({
            "type": "system",
            "subtype": "compact_boundary",
            "sessionId": SESSION_ID,
            "uuid": BOUNDARY_ID,
            "parentUuid": null,
            "logicalParentUuid": "11111111-1111-4111-8111-111111111111",
            "isSidechain": false,
            "version": "2.1.220"
        }),
        json!({
            "type": "user",
            "sessionId": SESSION_ID,
            "uuid": SUMMARY_ID,
            "parentUuid": BOUNDARY_ID,
            "isCompactSummary": true,
            "message": {"role": "user", "content": "retained summary"}
        }),
    ];
    let mut expected = Vec::new();
    for record in records {
        let mut line = serde_json::to_vec(&record).unwrap();
        line.push(b'\n');
        file.write_all(&line).unwrap();
        expected.extend_from_slice(&line);
    }
    file.flush().unwrap();

    let selection = select_claude_compact_generation(file.path(), SESSION_ID).unwrap();
    let ClaudeHistorySelection::Candidate(candidate) = selection else {
        panic!("expected an eligible compact generation");
    };

    assert!(candidate.source_size() > CLAUDE_COMPACT_GENERATION_MAX_BYTES);
    assert_eq!(candidate.candidate_size(), expected.len() as u64);
    assert_eq!(candidate.into_bytes(), expected);
}
