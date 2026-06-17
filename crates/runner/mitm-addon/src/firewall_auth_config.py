"""Pure firewall auth config predicates."""


def _non_empty_mapping(value: object) -> bool:
    return isinstance(value, dict) and bool(value)


def auth_config_injects_credentials(auth_config: object) -> bool:
    """Return whether a firewall auth config can add managed credentials."""
    if not isinstance(auth_config, dict):
        return False
    if _non_empty_mapping(auth_config.get("headers")):
        return True
    if _non_empty_mapping(auth_config.get("query")):
        return True
    if _non_empty_mapping(auth_config.get("awsSigv4")):
        return True
    return isinstance(auth_config.get("base"), str) and auth_config["base"] != ""
