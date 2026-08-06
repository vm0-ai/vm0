//! Guest-local Pi standby controls delivered by runner process control.

use tokio::sync::mpsc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PiStandbySignal {
    Handoff,
    Release,
}

pub struct PiStandbyRuntime {
    controller: PiStandbyController,
    reader: PiStandbyReader,
}

#[derive(Clone)]
pub struct PiStandbyController {
    sender: mpsc::UnboundedSender<PiStandbySignal>,
}

pub struct PiStandbyReader {
    receiver: mpsc::UnboundedReceiver<PiStandbySignal>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PiStandbyPayload {
    #[serde(rename = "type")]
    payload_type: String,
}

impl PiStandbyRuntime {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        Self {
            controller: PiStandbyController { sender },
            reader: PiStandbyReader { receiver },
        }
    }

    pub fn controller(&self) -> PiStandbyController {
        self.controller.clone()
    }

    pub fn into_reader(self) -> PiStandbyReader {
        self.reader
    }
}

impl Default for PiStandbyRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl PiStandbyController {
    pub fn handle_control_payload(&self, payload: &[u8]) -> Result<bool, String> {
        let Some(payload_type) = serde_json::from_slice::<serde_json::Value>(payload)
            .ok()
            .and_then(|value| value.get("type")?.as_str().map(str::to_owned))
        else {
            return Ok(false);
        };
        let signal = match payload_type.as_str() {
            "pi-handoff" => PiStandbySignal::Handoff,
            "pi-standby-release" => PiStandbySignal::Release,
            _ => return Ok(false),
        };
        let parsed: PiStandbyPayload = serde_json::from_slice(payload)
            .map_err(|error| format!("Pi standby payload is invalid: {error}"))?;
        if parsed.payload_type != payload_type {
            return Err("Pi standby payload type changed while parsing".to_string());
        }
        self.sender
            .send(signal)
            .map_err(|_| "Pi standby receiver is closed".to_string())?;
        Ok(true)
    }
}

impl PiStandbyReader {
    pub fn closed() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        drop(sender);
        Self { receiver }
    }

    pub async fn recv(&mut self) -> Option<PiStandbySignal> {
        self.receiver.recv().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn controls_preserve_handoff_and_release_as_distinct_signals() {
        let runtime = PiStandbyRuntime::new();
        let controller = runtime.controller();
        let mut reader = runtime.into_reader();

        assert_eq!(
            controller.handle_control_payload(br#"{"type":"pi-handoff"}"#),
            Ok(true)
        );
        assert_eq!(reader.recv().await, Some(PiStandbySignal::Handoff));
        assert_eq!(
            controller.handle_control_payload(br#"{"type":"pi-standby-release"}"#),
            Ok(true)
        );
        assert_eq!(reader.recv().await, Some(PiStandbySignal::Release));
    }
}
