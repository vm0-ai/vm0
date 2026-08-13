use api_contracts::DecodePathMapSegment;
use api_contracts::generated::decode_paths;

#[test]
fn claim_schema_traverses_fixed_fields_typed_maps_and_sequences() {
    let root = decode_paths::runners::jobs::by_id::claim::RESPONSE.root();

    let DecodePathMapSegment::Field(policies) = root.map_segment("networkPolicies") else {
        panic!("networkPolicies should be a fixed claim field");
    };
    let DecodePathMapSegment::DynamicKey(policy) = policies.map_segment("runtime-name") else {
        panic!("network policy names should be dynamic map keys");
    };
    assert!(matches!(
        policy.map_segment("unknownPolicy"),
        DecodePathMapSegment::Field(_)
    ));

    let DecodePathMapSegment::Field(firewalls) = root.map_segment("firewalls") else {
        panic!("firewalls should be a fixed claim field");
    };
    assert!(matches!(
        firewalls.sequence_item().map_segment("kind"),
        DecodePathMapSegment::Field(_)
    ));
}

#[test]
fn claim_schema_keeps_opaque_and_unknown_descendants_unprintable() {
    let root = decode_paths::runners::jobs::by_id::claim::RESPONSE.root();
    let DecodePathMapSegment::Field(codex) = root.map_segment("codexRuntimeConfig") else {
        panic!("codexRuntimeConfig should be a fixed claim field");
    };
    let DecodePathMapSegment::Field(catalog) = codex.map_segment("modelCatalog") else {
        panic!("modelCatalog should be a fixed Codex field");
    };
    let DecodePathMapSegment::DynamicKey(opaque) = catalog.map_segment("runtime-model") else {
        panic!("model catalog names should be dynamic map keys");
    };
    assert!(matches!(
        opaque.map_segment("providerId"),
        DecodePathMapSegment::Unknown(_)
    ));

    let DecodePathMapSegment::Unknown(unknown) = root.map_segment("missing") else {
        panic!("undeclared claim field should be unknown");
    };
    assert!(matches!(
        unknown.map_segment("prompt"),
        DecodePathMapSegment::Unknown(_)
    ));
    assert!(matches!(
        unknown.sequence_item().map_segment("prompt"),
        DecodePathMapSegment::Unknown(_)
    ));
}

#[test]
fn response_roots_keep_firewalls_location_specific() {
    let claim = decode_paths::runners::jobs::by_id::claim::RESPONSE.root();
    let DecodePathMapSegment::Field(claim_firewalls) = claim.map_segment("firewalls") else {
        panic!("firewalls should be a fixed claim field");
    };
    assert!(matches!(
        claim_firewalls.map_segment("runtime-name"),
        DecodePathMapSegment::Unknown(_)
    ));

    let catalog = decode_paths::runners::builtin_firewalls::resolve::RESPONSE.root();
    let DecodePathMapSegment::Field(catalog_firewalls) = catalog.map_segment("firewalls") else {
        panic!("firewalls should be a fixed catalog field");
    };
    assert!(matches!(
        catalog_firewalls.map_segment("runtime-name"),
        DecodePathMapSegment::DynamicKey(_)
    ));
}
