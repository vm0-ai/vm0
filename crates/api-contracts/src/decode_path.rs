/// Contract-owned JSON response shape used to sanitize decode paths.
pub struct DecodePathSchema {
    nodes: &'static [DecodePathNode],
    fields: &'static [DecodePathField],
}

impl DecodePathSchema {
    /// Creates generated decode-path metadata from immutable node and field tables.
    #[must_use]
    pub(crate) const fn new(
        nodes: &'static [DecodePathNode],
        fields: &'static [DecodePathField],
    ) -> Self {
        Self { nodes, fields }
    }

    /// Starts traversal at the response root.
    #[must_use]
    pub fn root(&'static self) -> DecodePathCursor {
        DecodePathCursor {
            schema: self,
            node: Some(0),
        }
    }
}

/// One location in a generated response decode-path schema.
#[derive(Clone, Copy)]
pub struct DecodePathCursor {
    schema: &'static DecodePathSchema,
    node: Option<usize>,
}

impl DecodePathCursor {
    /// Classifies and advances through one Serde map segment.
    #[must_use]
    pub fn map_segment(self, key: &str) -> DecodePathMapSegment {
        let Some(node) = self.node.and_then(|index| self.schema.nodes.get(index)) else {
            return DecodePathMapSegment::Unknown(self.unknown());
        };

        match node {
            DecodePathNode::Object(field_start, field_len) => {
                let Some(fields) = self
                    .schema
                    .fields
                    .get(*field_start..field_start + field_len)
                else {
                    return DecodePathMapSegment::Unknown(self.unknown());
                };
                fields.iter().find(|field| field.name == key).map_or_else(
                    || DecodePathMapSegment::Unknown(self.unknown()),
                    |field| DecodePathMapSegment::Field(self.at(field.node)),
                )
            }
            DecodePathNode::DynamicMap(value) => DecodePathMapSegment::DynamicKey(self.at(*value)),
            DecodePathNode::Leaf | DecodePathNode::Sequence(_) => {
                DecodePathMapSegment::Unknown(self.unknown())
            }
        }
    }

    /// Advances through one Serde sequence index, failing closed on a shape mismatch.
    #[must_use]
    pub fn sequence_item(self) -> Self {
        let Some(DecodePathNode::Sequence(item)) =
            self.node.and_then(|index| self.schema.nodes.get(index))
        else {
            return self.unknown();
        };
        self.at(*item)
    }

    /// Enters a state in which no later map segment is printable.
    #[must_use]
    pub fn unknown(self) -> Self {
        Self {
            schema: self.schema,
            node: None,
        }
    }

    fn at(self, node: usize) -> Self {
        Self {
            schema: self.schema,
            node: Some(node),
        }
    }
}

/// Classification result for one map segment in a response decode path.
#[derive(Clone, Copy)]
pub enum DecodePathMapSegment {
    /// The segment is an exact field declared at the current schema location.
    Field(DecodePathCursor),
    /// The segment is a runtime-controlled key in a declared dynamic map.
    DynamicKey(DecodePathCursor),
    /// The segment is not printable and all descendant fields remain unknown.
    Unknown(DecodePathCursor),
}

/// One generated response-shape node.
pub(crate) enum DecodePathNode {
    /// A scalar or opaque value with no printable descendant fields.
    Leaf,
    /// A fixed object represented by a start offset and length in the field table.
    Object(usize, usize),
    /// A sequence whose indexes share one item node.
    Sequence(usize),
    /// A map with runtime-controlled keys and one value node.
    DynamicMap(usize),
}

/// One generated fixed object field.
pub(crate) struct DecodePathField {
    name: &'static str,
    node: usize,
}

impl DecodePathField {
    /// Creates a generated fixed-field transition.
    #[must_use]
    pub(crate) const fn new(name: &'static str, node: usize) -> Self {
        Self { name, node }
    }
}
