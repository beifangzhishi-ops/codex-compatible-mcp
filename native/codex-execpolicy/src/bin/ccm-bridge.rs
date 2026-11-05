// CCM transport adapter. The rule parser/evaluator/persistence remain the
// unchanged upstream codex-execpolicy Rust library at
// ed8eac40832e6a79f30eaeb3c521912f231d43eb.
// Apache-2.0: third_party/openai-codex/LICENSE.
use codex_execpolicy::MatchOptions;
use codex_execpolicy::PolicyParser;
use codex_execpolicy::RuleMatch;
use codex_execpolicy::blocking_append_allow_prefix_rule;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::Path;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Check {
        rules: Vec<String>,
        tokens: Vec<String>,
        #[serde(default)]
        resolve_host_executables: bool,
    },
    AppendAllow {
        path: String,
        prefix: Vec<String>,
    },
}

fn handle(request: Request) -> Result<Value, String> {
    match request {
        Request::Check {
            rules,
            tokens,
            resolve_host_executables,
        } => {
            let mut parser = PolicyParser::new();
            for rule_path in rules {
                let contents = fs::read_to_string(&rule_path)
                    .map_err(|error| format!("failed to read {rule_path}: {error}"))?;
                parser
                    .parse(&rule_path, &contents)
                    .map_err(|error| format!("failed to parse {rule_path}: {error}"))?;
            }
            let matches = parser.build().matches_for_command_with_options(
                &tokens,
                None,
                &MatchOptions {
                    resolve_host_executables,
                },
            );
            let decision = matches.iter().map(RuleMatch::decision).max();
            let mut response = json!({ "matchedRules": matches });
            if let Some(value) = decision {
                response["decision"] =
                    serde_json::to_value(value).map_err(|error| error.to_string())?;
            }
            Ok(response)
        }
        Request::AppendAllow { path, prefix } => {
            blocking_append_allow_prefix_rule(Path::new(&path), &prefix)
                .map_err(|error| error.to_string())?;
            Ok(json!({ "saved": true }))
        }
    }
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for input in stdin.lock().lines() {
        let input = input?;
        let answer = match serde_json::from_str::<Request>(&input) {
            Ok(request) => handle(request),
            Err(error) => Err(error.to_string()),
        };
        let response = match answer {
            Ok(result) => json!({ "ok": true, "result": result }),
            Err(error) => json!({ "ok": false, "error": error }),
        };
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(stdout)?;
        stdout.flush()?;
    }
    Ok(())
}
