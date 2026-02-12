//! Ably Pub/Sub subscribe-only Realtime SDK.
//!
//! Implements the minimum subset of the Ably realtime protocol needed for
//! subscribing to channels via WebSocket with MessagePack encoding.
//!
//! # Features
//! - TokenRequest-based authentication (exchange with Ably REST API)
//! - MessagePack binary protocol (Ably default)
//! - Automatic connection resume after disconnection
//! - Proactive token renewal before expiry
//! - Heartbeat-based connection liveness detection
//!
//! # Example
//! ```no_run
//! # async fn example() -> Result<(), ably_subscriber::Error> {
//! use ably_subscriber::{SubscribeConfig, Event};
//!
//! let config = ably_subscriber::SubscribeConfig {
//!     get_token: Box::new(|| Box::pin(async { todo!() })),
//!     channel: "my-channel".to_string(),
//!     channel_params: None,
//!     host: None,
//!     rest_host: None,
//! };
//!
//! let mut sub = ably_subscriber::subscribe(config).await?;
//! while let Some(event) = sub.next().await {
//!     match event {
//!         Event::Message(msg) => println!("got: {:?}", msg.name),
//!         Event::Connected => println!("connected"),
//!         _ => {}
//!     }
//! }
//! # Ok(())
//! # }
//! ```

mod connection;
mod protocol;
mod subscribe;
mod types;

pub use subscribe::{Subscription, subscribe};
pub use types::{
    BoxError, Error, Event, Message, SubscribeConfig, TokenDetails, TokenFuture, TokenRequest,
};
