use crate::error::{NbdCowError, Result};

const NLMSG_HEADER_LEN: usize = 16;
const GENL_HEADER_LEN: usize = 4;
const GENL_ATTR_OFFSET: usize = NLMSG_HEADER_LEN + GENL_HEADER_LEN;

const NLMSG_LEN_OFFSET: usize = 0;
const NLMSG_TYPE_OFFSET: usize = 4;
const NLMSG_FLAGS_OFFSET: usize = 6;
const NLMSG_SEQ_OFFSET: usize = 8;
const NLMSG_ERROR_CODE_OFFSET: usize = NLMSG_HEADER_LEN;

const GENL_CMD_OFFSET: usize = NLMSG_HEADER_LEN;
const GENL_VERSION_OFFSET: usize = NLMSG_HEADER_LEN + 1;

const U16_LEN: usize = 2;
const U32_LEN: usize = 4;

const NLM_F_REQUEST: u16 = 1;
const NLM_F_ACK: u16 = 4;
const NLMSG_ERROR: u16 = 2;

const NLA_HEADER_LEN: usize = 4;
const NLA_ALIGNTO: usize = 4;
const NLA_F_NESTED: u16 = 1 << 15;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct NlHeader {
    pub(super) len: usize,
    pub(super) msg_type: u16,
    pub(super) seq: u32,
}

/// Result of parsing a single netlink message.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum NlMsg {
    /// NLMSG_ERROR with error=0 (ACK).
    Ack,
    /// Non-error message (genetlink reply or broadcast).
    Reply,
}

pub(super) fn build_genl_msg(
    msg_type: u16,
    cmd: u8,
    version: u8,
    attrs: &[u8],
    seq: u32,
    request_ack: bool,
) -> Vec<u8> {
    let total_len = GENL_ATTR_OFFSET + attrs.len();
    assert!(total_len <= u32::MAX as usize, "netlink message too large");
    let mut msg = vec![0u8; total_len];

    write_at(
        &mut msg,
        NLMSG_LEN_OFFSET,
        &(total_len as u32).to_ne_bytes(),
    );
    write_at(&mut msg, NLMSG_TYPE_OFFSET, &msg_type.to_ne_bytes());

    let mut flags = NLM_F_REQUEST;
    if request_ack {
        flags |= NLM_F_ACK;
    }
    write_at(&mut msg, NLMSG_FLAGS_OFFSET, &flags.to_ne_bytes());
    write_at(&mut msg, NLMSG_SEQ_OFFSET, &seq.to_ne_bytes());

    // pid and genl reserved fields are intentionally left as zero.
    if let Some(b) = msg.get_mut(GENL_CMD_OFFSET) {
        *b = cmd;
    }
    if let Some(b) = msg.get_mut(GENL_VERSION_OFFSET) {
        *b = version;
    }
    if let Some(dest) = msg.get_mut(GENL_ATTR_OFFSET..) {
        dest.copy_from_slice(attrs);
    }

    msg
}

pub(super) fn parse_nl_header(buf: &[u8], n: usize) -> Result<NlHeader> {
    let received = received_slice(buf, n)?;
    if received.len() < NLMSG_HEADER_LEN {
        return Err(NbdCowError::Netlink("message too short".into()));
    }

    Ok(NlHeader {
        len: read_u32_at(
            received,
            NLMSG_LEN_OFFSET,
            "msg_len slice",
            "msg_len conversion",
        )? as usize,
        msg_type: read_u16_at(
            received,
            NLMSG_TYPE_OFFSET,
            "msg_type slice",
            "msg_type conversion",
        )?,
        seq: read_u32_at(received, NLMSG_SEQ_OFFSET, "seq slice", "seq conversion")?,
    })
}

/// Parse a single netlink message from the buffer. Returns `NlMsg` on
/// success, or an error for NLMSG_ERROR with non-zero errno.
pub(super) fn parse_nl_msg(buf: &[u8], n: usize) -> Result<NlMsg> {
    let received = received_slice(buf, n)?;
    let header = parse_nl_header(buf, n)?;
    if header.len < NLMSG_HEADER_LEN {
        return Err(NbdCowError::Netlink("message too short".into()));
    }

    let msg = received
        .get(..header.len)
        .ok_or_else(|| NbdCowError::Netlink("truncated netlink message".into()))?;

    if header.msg_type == NLMSG_ERROR {
        let error = read_i32_at(
            msg,
            NLMSG_ERROR_CODE_OFFSET,
            "error response too short",
            "error code conversion",
        )?;
        if error == 0 {
            return Ok(NlMsg::Ack);
        }
        let errno = -error;
        return Err(NbdCowError::NetlinkErrno {
            errno,
            message: std::io::Error::from_raw_os_error(errno).to_string(),
        });
    }

    Ok(NlMsg::Reply)
}

pub(super) fn genl_attrs(buf: &[u8], n: usize) -> Result<&[u8]> {
    let received = received_slice(buf, n)?;
    if received.len() < GENL_ATTR_OFFSET {
        return Err(NbdCowError::Netlink("response too short".into()));
    }
    received
        .get(GENL_ATTR_OFFSET..)
        .ok_or_else(|| NbdCowError::Netlink("response too short".into()))
}

pub(super) fn find_nla_u16(
    attrs: &[u8],
    target_type: u16,
    truncated_value_message: &'static str,
) -> Result<Option<u16>> {
    let mut offset = 0usize;
    while offset + NLA_HEADER_LEN <= attrs.len() {
        let nla_len = read_u16_at(attrs, offset, "truncated nla", "nla len conversion")? as usize;
        let nla_type = read_u16_at(
            attrs,
            offset + U16_LEN,
            "truncated nla",
            "nla type conversion",
        )?;

        if nla_type == target_type && nla_len >= NLA_HEADER_LEN + U16_LEN {
            return read_u16_at(
                attrs,
                offset + NLA_HEADER_LEN,
                truncated_value_message,
                "id conversion",
            )
            .map(Some);
        }

        let aligned = align_nla_len(nla_len);
        if aligned == 0 {
            break;
        }
        offset = offset
            .checked_add(aligned)
            .ok_or_else(|| NbdCowError::Netlink("nla offset overflow".into()))?;
    }

    Ok(None)
}

/// Build a netlink attribute (NLA).
pub(super) fn build_nla(nla_type: u16, payload: &[u8]) -> Vec<u8> {
    build_nla_with_encoded_type(nla_type, payload, "NLA payload too large")
}

/// Build a nested netlink attribute.
pub(super) fn build_nested_nla(nla_type: u16, payload: &[u8]) -> Vec<u8> {
    build_nla_with_encoded_type(
        nla_type | NLA_F_NESTED,
        payload,
        "nested NLA payload too large",
    )
}

fn build_nla_with_encoded_type(
    encoded_type: u16,
    payload: &[u8],
    too_large_message: &'static str,
) -> Vec<u8> {
    let nla_len = NLA_HEADER_LEN + payload.len();
    assert!(nla_len <= u16::MAX as usize, "{too_large_message}");
    let aligned_len = align_nla_len(nla_len);
    let mut buf = vec![0u8; aligned_len];

    if let Some(header) = buf.get_mut(..NLA_HEADER_LEN) {
        write_at(header, 0, &(nla_len as u16).to_ne_bytes());
        write_at(header, U16_LEN, &encoded_type.to_ne_bytes());
    }
    if let Some(dest) = buf.get_mut(NLA_HEADER_LEN..NLA_HEADER_LEN + payload.len()) {
        dest.copy_from_slice(payload);
    }
    buf
}

fn received_slice(buf: &[u8], n: usize) -> Result<&[u8]> {
    buf.get(..n)
        .ok_or_else(|| NbdCowError::Netlink("recv length exceeds buffer".into()))
}

fn read_u16_at(
    buf: &[u8],
    offset: usize,
    slice_message: &'static str,
    conversion_message: &'static str,
) -> Result<u16> {
    let bytes: [u8; U16_LEN] = buf
        .get(offset..offset + U16_LEN)
        .ok_or_else(|| NbdCowError::Netlink(slice_message.into()))?
        .try_into()
        .map_err(|_| NbdCowError::Netlink(conversion_message.into()))?;
    Ok(u16::from_ne_bytes(bytes))
}

fn read_u32_at(
    buf: &[u8],
    offset: usize,
    slice_message: &'static str,
    conversion_message: &'static str,
) -> Result<u32> {
    let bytes: [u8; U32_LEN] = buf
        .get(offset..offset + U32_LEN)
        .ok_or_else(|| NbdCowError::Netlink(slice_message.into()))?
        .try_into()
        .map_err(|_| NbdCowError::Netlink(conversion_message.into()))?;
    Ok(u32::from_ne_bytes(bytes))
}

fn read_i32_at(
    buf: &[u8],
    offset: usize,
    slice_message: &'static str,
    conversion_message: &'static str,
) -> Result<i32> {
    let bytes: [u8; U32_LEN] = buf
        .get(offset..offset + U32_LEN)
        .ok_or_else(|| NbdCowError::Netlink(slice_message.into()))?
        .try_into()
        .map_err(|_| NbdCowError::Netlink(conversion_message.into()))?;
    Ok(i32::from_ne_bytes(bytes))
}

fn write_at(buf: &mut [u8], offset: usize, bytes: &[u8]) {
    if let Some(dest) = buf.get_mut(offset..offset + bytes.len()) {
        dest.copy_from_slice(bytes);
    }
}

fn align_nla_len(len: usize) -> usize {
    (len + NLA_ALIGNTO - 1) & !(NLA_ALIGNTO - 1)
}

#[cfg(test)]
pub(super) fn build_nlmsg_error_for_test(seq: u32, error: i32) -> Vec<u8> {
    let mut buf = vec![0u8; NLMSG_HEADER_LEN + U32_LEN + U32_LEN];
    let len = buf.len() as u32;
    write_at(&mut buf, NLMSG_LEN_OFFSET, &len.to_ne_bytes());
    write_at(&mut buf, NLMSG_TYPE_OFFSET, &NLMSG_ERROR.to_ne_bytes());
    write_at(&mut buf, NLMSG_SEQ_OFFSET, &seq.to_ne_bytes());
    write_at(&mut buf, NLMSG_ERROR_CODE_OFFSET, &error.to_ne_bytes());
    buf
}

#[cfg(test)]
pub(super) fn set_nlmsg_len_for_test(buf: &mut [u8], len: u32) {
    write_at(buf, NLMSG_LEN_OFFSET, &len.to_ne_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nlmsg_flags(msg: &[u8]) -> u16 {
        read_u16_at(msg, NLMSG_FLAGS_OFFSET, "flags slice", "flags conversion").unwrap()
    }

    #[test]
    fn build_nla_basic() {
        let payload: &[u8] = &[0xAA, 0xBB];
        let nla = build_nla(42, payload);

        assert_eq!(
            read_u16_at(&nla, 0, "len slice", "len conversion").unwrap(),
            6
        );
        assert_eq!(
            read_u16_at(&nla, U16_LEN, "type slice", "type conversion").unwrap(),
            42
        );
        assert_eq!(
            nla.get(NLA_HEADER_LEN..NLA_HEADER_LEN + payload.len()),
            Some(payload)
        );
    }

    #[test]
    fn build_nla_padding_to_4byte_alignment() {
        let payload: &[u8] = &[1, 2, 3];
        let nla = build_nla(1, payload);

        assert_eq!(nla.len(), 8);
        assert_eq!(
            nla.get(NLA_HEADER_LEN..NLA_HEADER_LEN + payload.len()),
            Some(payload)
        );
        assert_eq!(nla.get(7), Some(&0));
    }

    #[test]
    fn build_nla_no_padding_when_aligned() {
        let payload: &[u8] = &[1, 2, 3, 4];
        let nla = build_nla(1, payload);

        assert_eq!(nla.len(), 8);
    }

    #[test]
    fn build_nla_empty_payload() {
        let nla = build_nla(99, &[]);

        assert_eq!(nla.len(), NLA_HEADER_LEN);
        assert_eq!(
            read_u16_at(&nla, 0, "len slice", "len conversion").unwrap(),
            NLA_HEADER_LEN as u16
        );
    }

    #[test]
    fn build_nested_nla_sets_nested_flag() {
        let payload: &[u8] = &[0xDE, 0xAD];
        let nla = build_nested_nla(7, payload);

        assert_eq!(
            read_u16_at(&nla, U16_LEN, "type slice", "type conversion").unwrap(),
            7 | NLA_F_NESTED
        );
        assert_eq!(nla.len(), 8);
    }

    #[test]
    fn build_nested_nla_matches_regular_payload_and_padding() {
        let payload: &[u8] = &[1, 2, 3];
        let nla = build_nla(7, payload);
        let nested_nla = build_nested_nla(7, payload);

        assert_eq!(nested_nla.len(), nla.len());
        assert_eq!(
            read_u16_at(&nested_nla, 0, "nested len slice", "nested len conversion").unwrap(),
            read_u16_at(&nla, 0, "len slice", "len conversion").unwrap()
        );
        assert_eq!(
            read_u16_at(
                &nested_nla,
                U16_LEN,
                "nested type slice",
                "nested type conversion"
            )
            .unwrap(),
            read_u16_at(&nla, U16_LEN, "type slice", "type conversion").unwrap() | NLA_F_NESTED
        );
        assert_eq!(nested_nla.get(NLA_HEADER_LEN..), nla.get(NLA_HEADER_LEN..));
    }

    #[test]
    fn build_genl_msg_can_omit_ack_for_family_lookup() {
        let attrs = build_nla(2, b"nbd\0");
        let msg = build_genl_msg(0x10, 3, 1, &attrs, 42, false);
        let header = parse_nl_header(&msg, msg.len()).unwrap();

        assert_eq!(nlmsg_flags(&msg), NLM_F_REQUEST);
        assert_eq!(header.seq, 42);
    }

    #[test]
    fn build_genl_msg_requests_ack_for_nbd_command() {
        let attrs = build_nla(1, &7u32.to_ne_bytes());
        let msg = build_genl_msg(0x19, 1, 1, &attrs, 43, true);
        let header = parse_nl_header(&msg, msg.len()).unwrap();

        assert_eq!(nlmsg_flags(&msg), NLM_F_REQUEST | NLM_F_ACK);
        assert_eq!(header.seq, 43);
    }

    #[test]
    fn parse_nl_msg_ack() {
        let msg = build_nlmsg_error_for_test(42, 0);

        assert!(matches!(parse_nl_msg(&msg, msg.len()), Ok(NlMsg::Ack)));
        assert_eq!(parse_nl_header(&msg, msg.len()).unwrap().seq, 42);
    }

    #[test]
    fn parse_nl_msg_reply() {
        let msg = build_genl_msg(0x0019, 1, 1, &[], 43, false);

        assert!(matches!(parse_nl_msg(&msg, msg.len()), Ok(NlMsg::Reply)));
        assert_eq!(parse_nl_header(&msg, msg.len()).unwrap().seq, 43);
    }

    #[test]
    fn parse_nl_msg_error_errno() {
        let msg = build_nlmsg_error_for_test(2, -libc::EBUSY);

        let result = parse_nl_msg(&msg, msg.len());
        assert!(matches!(
            result,
            Err(NbdCowError::NetlinkErrno { errno, .. }) if errno == libc::EBUSY
        ));
    }

    #[test]
    fn parse_nl_msg_too_short() {
        let buf = [0u8; NLMSG_HEADER_LEN - 1];
        let result = parse_nl_msg(&buf, buf.len());

        assert!(result.is_err());
    }

    #[test]
    fn parse_nl_msg_error_response_truncated() {
        let mut buf = vec![0u8; 4096];
        write_at(&mut buf, NLMSG_LEN_OFFSET, &20u32.to_ne_bytes());
        write_at(&mut buf, NLMSG_TYPE_OFFSET, &NLMSG_ERROR.to_ne_bytes());

        let result = parse_nl_msg(&buf, 18);

        assert!(result.is_err());
    }

    #[test]
    fn parse_nl_msg_declared_length_too_short() {
        let mut buf = vec![0u8; NLMSG_HEADER_LEN + U32_LEN + U32_LEN];
        write_at(&mut buf, NLMSG_LEN_OFFSET, &15u32.to_ne_bytes());

        let result = parse_nl_msg(&buf, buf.len());

        assert!(result.is_err());
    }

    #[test]
    fn parse_nl_msg_error_body_bounded_by_declared_length() {
        let mut buf = build_nlmsg_error_for_test(2, 0);
        write_at(&mut buf, NLMSG_LEN_OFFSET, &18u32.to_ne_bytes());

        let result = parse_nl_msg(&buf, buf.len());

        assert!(result.is_err());
    }
}
