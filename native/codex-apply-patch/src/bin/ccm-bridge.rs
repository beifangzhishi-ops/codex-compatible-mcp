// CCM JSON transport only. The patch parser, matching, file update, and
// ordered application are upstream openai/codex @ ed8eac40832e6a79f30eaeb3c521912f231d43eb.
use codex_apply_patch::AppliedPatchFileChange;
use codex_exec_server::{FileSystemSandboxContext, LOCAL_FS};
use codex_utils_path_uri::PathUri;
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::path::PathBuf;

#[derive(Deserialize)]
struct Request {
    patch: String,
    workdir: PathBuf,
    workspace_roots: Vec<PathBuf>,
    profile: String,
}

#[derive(Serialize)]
struct Change {
    r#type: &'static str,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    destination: Option<String>,
    summary: String,
}

#[derive(Serialize)]
struct Response {
    ok: bool,
    output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    changes: Vec<Change>,
}

fn changes_from_delta(delta: &codex_apply_patch::AppliedPatchDelta) -> Vec<Change> {
    delta.changes().iter().map(|change| {
        let path = change.path.inferred_native_path_string();
        match &change.change {
            AppliedPatchFileChange::Add { .. } => Change {
                r#type: "add",
                summary: format!("A {path}"),
                path,
                destination: None,
            },
            AppliedPatchFileChange::Delete { .. } => Change {
                r#type: "delete",
                summary: format!("D {path}"),
                path,
                destination: None,
            },
            AppliedPatchFileChange::Update { move_path, .. } => {
                let destination = move_path.as_ref().map(PathUri::inferred_native_path_string);
                Change {
                    r#type: if destination.is_some() { "move" } else { "update" },
                    summary: format!("M {}", destination.as_deref().unwrap_or(&path)),
                    path,
                    destination,
                }
            }
        }
    }).collect()
}

async fn apply(request: Request) -> Response {
    let fail = |message: String| Response {
        ok: false,
        output: String::new(),
        error: Some(message),
        changes: Vec::new(),
    };
    let sandbox = match request.profile.as_str() {
        "full-access" => None,
        "workspace-write" => match FileSystemSandboxContext::new(&request.workspace_roots) {
            Ok(context) => Some(context),
            Err(error) => return fail(error.to_string()),
        },
        "read-only" => return fail("environment is read-only".to_string()),
        _ => return fail(format!("unsupported permission profile: {}", request.profile)),
    };
    let cwd = match PathUri::from_host_native_path(&request.workdir) {
        Ok(cwd) => cwd,
        Err(error) => return fail(error.to_string()),
    };
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let result = codex_apply_patch::apply_patch(
        &request.patch, &cwd, &mut stdout, &mut stderr,
        LOCAL_FS.as_ref(), sandbox.as_ref(),
    ).await;
    let stdout = String::from_utf8_lossy(&stdout).into_owned();
    let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
    match result {
        Ok(delta) => Response {
            ok: true, output: stdout, error: None,
            changes: changes_from_delta(&delta),
        },
        Err(error) => Response {
            ok: false,
            output: stdout,
            error: Some(if stderr.is_empty() { error.to_string() } else { stderr }),
            changes: changes_from_delta(error.delta()),
        },
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let response = match serde_json::from_str::<Request>(&input) {
        Ok(request) => apply(request).await,
        Err(error) => Response {
            ok: false, output: String::new(), error: Some(error.to_string()),
            changes: Vec::new(),
        },
    };
    serde_json::to_writer(io::stdout().lock(), &response)?;
    Ok(())
}
