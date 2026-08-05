//! Compatibility help loaded from the generated TypeScript CLI inventory.

use serde::Deserialize;

use crate::dispatch::{Invocation, RegistryError};

const SURFACE_INVENTORY: &str =
    include_str!("../../../turbo/apps/cli/generated/zero-cli-surface.v1.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceInventory {
    commands: Vec<CommandSurface>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandSurface {
    path: Vec<String>,
    name: String,
    aliases: Vec<String>,
    help_text: String,
}

pub(super) fn render(invocation: &Invocation) -> Result<String, RegistryError> {
    let inventory: SurfaceInventory =
        serde_json::from_str(SURFACE_INVENTORY).map_err(|_| RegistryError::InvalidHelpInventory)?;
    let mut selected_path = vec![String::from("zero")];
    let mut selected = None;

    for argument in invocation.args() {
        let Some(argument) = argument.to_str() else {
            break;
        };
        if argument.starts_with('-') {
            break;
        }

        let next = inventory.commands.iter().find(|command| {
            command.path.len() == selected_path.len() + 1
                && command.path.starts_with(&selected_path)
                && (command.name == argument
                    || command.aliases.iter().any(|alias| alias == argument))
        });
        let Some(next) = next else {
            break;
        };
        selected_path.push(next.name.clone());
        selected = Some(next);
    }

    selected
        .map(|command| command.help_text.clone())
        .ok_or(RegistryError::MissingSelectedHelp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_exact_nested_help_from_the_surface_inventory() {
        let invocation = Invocation::from_args(["model".into(), "list".into(), "--help".into()]);
        let help = render(&invocation).unwrap();

        assert!(help.starts_with("Usage: zero model list|ls [options]"));
        assert!(help.ends_with('\n'));
    }

    #[test]
    fn resolves_command_aliases_to_the_same_inventory_entry() {
        let list = render(&Invocation::from_args([
            "model".into(),
            "list".into(),
            "--help".into(),
        ]))
        .unwrap();
        let alias = render(&Invocation::from_args([
            "model".into(),
            "ls".into(),
            "--help".into(),
        ]))
        .unwrap();

        assert_eq!(alias, list);
    }
}
