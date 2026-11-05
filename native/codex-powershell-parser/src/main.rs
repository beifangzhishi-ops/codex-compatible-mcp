// Adapter for the upstream Codex PowerShell Tree-sitter command lowering.
// Upstream: openai/codex @ ed8eac40832e6a79f30eaeb3c521912f231d43eb
// codex-rs/shell-command/src/command_safety/powershell_tree_sitter.rs
// Apache-2.0, see third_party/openai-codex/LICENSE.
mod powershell_tree_sitter;

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    script: String,
}

#[derive(Serialize)]
struct Response {
    commands: Option<Vec<Vec<String>>>,
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        let request: Result<Request, _> = serde_json::from_str(&line);
        let response = match request {
            Ok(request) => Response {
                commands: powershell_tree_sitter::try_parse_powershell_commands(&request.script),
            },
            Err(_) => Response { commands: None },
        };
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(stdout)?;
        stdout.flush()?;
    }
    Ok(())
}
