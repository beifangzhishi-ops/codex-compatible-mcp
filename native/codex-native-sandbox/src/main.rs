// CCM executable adapter for the unmodified Codex Windows sandbox library.
// Source baseline: openai/codex @ f79b26ccbb3116b052544666a181012fb45dc49b.
// Licensed Apache-2.0: third_party/openai-codex/LICENSE.
//
// The only implementation here is the explicit CCM process-launch transport.
// Accounts, ACLs, provisioning, restricted tokens, WFP, IPC, job lifetime,
// PTY/stdin and output streams remain entirely in codex-windows-sandbox.
use anyhow::{Context, Result, bail, ensure};
use std::env;
use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq)]
struct Launch {
    workspace_root: PathBuf,
    codex_home: PathBuf,
    cwd: PathBuf,
    profile: String,
    command: Vec<String>,
}

fn parse_launch(args: impl IntoIterator<Item = String>) -> Result<Launch> {
    let mut workspace_root = None;
    let mut codex_home = None;
    let mut cwd = None;
    let mut profile = None;
    let mut command = Vec::new();
    let mut parts = args.into_iter();
    while let Some(flag) = parts.next() {
        if flag == "--" {
            command.extend(parts);
            break;
        }
        let target = match flag.as_str() {
            "--workspace-root" => &mut workspace_root,
            "--codex-home" => &mut codex_home,
            "--cwd" => &mut cwd,
            "--profile" => &mut profile,
            _ => bail!("unknown native sandbox transport argument: {flag}"),
        };
        ensure!(
            target.is_none(),
            "duplicate native sandbox transport argument: {flag}"
        );
        let value = parts
            .next()
            .context("missing value for native sandbox transport argument")?;
        ensure!(
            !value.is_empty() && value != "--",
            "empty native sandbox argument: {flag}"
        );
        *target = Some(value);
    }
    let workspace_root = PathBuf::from(workspace_root.context("missing --workspace-root")?);
    let codex_home = PathBuf::from(codex_home.context("missing --codex-home")?);
    let cwd = PathBuf::from(cwd.context("missing --cwd")?);
    let profile = profile.context("missing --profile")?;
    ensure!(
        workspace_root.is_absolute(),
        "workspace root must be absolute"
    );
    ensure!(codex_home.is_absolute(), "Codex home must be absolute");
    ensure!(cwd.is_absolute(), "command cwd must be absolute");
    ensure!(
        matches!(profile.as_str(), "workspace-online" | "read-only"),
        "unsupported native Codex permission profile: {profile}"
    );
    ensure!(!command.is_empty(), "sandbox command must not be empty");
    Ok(Launch {
        workspace_root,
        codex_home,
        cwd,
        profile,
        command,
    })
}

#[cfg(windows)]
async fn execute(request: Launch) -> Result<i32> {
    use codex_protocol::config_types::WindowsSandboxLevel;
    use codex_protocol::models::PermissionProfile;
    use codex_protocol::permissions::NetworkSandboxPolicy;
    use codex_utils_absolute_path::AbsolutePathBuf;
    use codex_windows_sandbox::ResolvedWindowsSandboxPermissions;
    use codex_windows_sandbox::SandboxSetupRequest;
    use codex_windows_sandbox::WindowsSandboxProxySettingsMode;
    use codex_windows_sandbox::WindowsSandboxSessionRequest;
    use codex_windows_sandbox::forward_sandbox_session_stdio;
    use codex_windows_sandbox::resolve_windows_deny_read_paths;
    use codex_windows_sandbox::run_elevated_setup;
    use codex_windows_sandbox::run_setup_refresh;
    use codex_windows_sandbox::sandbox_setup_is_complete;
    use codex_windows_sandbox::spawn_windows_sandbox_session_for_level;
    use std::collections::HashMap;

    // Identical built-in profile semantics to the pinned Codex configuration:
    // permissions.workspace-online extends :workspace with network enabled;
    // permissions.read-only extends :read-only with restricted network.
    let profile = if request.profile == "workspace-online" {
        PermissionProfile::workspace_write_with(&[], NetworkSandboxPolicy::Enabled, false, false)
    } else {
        PermissionProfile::read_only()
    };
    let root = AbsolutePathBuf::try_from(request.workspace_root.clone())?;
    let cwd = AbsolutePathBuf::try_from(request.cwd.clone())?;
    let roots = [root];
    let env_map = env::vars().collect::<HashMap<String, String>>();

    // Same setup order as codex-rs/core/src/windows_sandbox.rs:
    // prepare_elevated_sandbox. Do not allow a weaker fallback.
    if !sandbox_setup_is_complete(&request.codex_home) {
        let permissions =
            ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots(
                &profile, &roots,
            )?;
        run_elevated_setup(SandboxSetupRequest {
            permissions: &permissions,
            command_cwd: cwd.as_path(),
            env_map: &env_map,
            codex_home: &request.codex_home,
            proxy_enforced: false,
        })?;
    }
    run_setup_refresh(
        &profile,
        &roots,
        cwd.as_path(),
        &env_map,
        &request.codex_home,
        false,
    )?;

    // Same policy-materialization and deny-read resolution as
    // codex-rs/cli/src/debug_sandbox.rs::run_command_under_windows_session.
    let (mut file_system, _) = profile.to_runtime_permissions();
    file_system.remove_skip_missing_path_entries();
    let file_system = file_system.materialize_project_roots_with_workspace_roots(&roots);
    let deny_read_paths =
        resolve_windows_deny_read_paths(&file_system, &cwd).map_err(anyhow::Error::msg)?;

    let spawned = spawn_windows_sandbox_session_for_level(WindowsSandboxSessionRequest {
        permission_profile: &profile,
        workspace_roots: &roots,
        codex_home: &request.codex_home,
        command: request.command,
        cwd: cwd.as_path(),
        env_map,
        windows_sandbox_level: WindowsSandboxLevel::Elevated,
        proxy_enforced: false,
        network_proxy_restricting_sid: None,
        proxy_settings_mode: WindowsSandboxProxySettingsMode::Preserve,
        timeout_ms: None,
        read_roots_override: None,
        read_roots_include_platform_defaults: false,
        write_roots_override: None,
        deny_read_paths_override: &deny_read_paths,
        deny_write_paths_override: &[],
        tty: false,
        stdin_open: true,
    })
    .await?;
    Ok(forward_sandbox_session_stdio(spawned).await)
}

#[tokio::main]
async fn main() {
    let result = async {
        let request = parse_launch(env::args().skip(1))?;
        #[cfg(windows)]
        {
            execute(request).await
        }
        #[cfg(not(windows))]
        {
            let _ = request;
            bail!("Codex Elevated Sandbox is Windows-only")
        }
    }
    .await;
    match result {
        Ok(exit_code) => std::process::exit(exit_code),
        Err(error) => {
            eprintln!("Codex native sandbox launch failed: {error:#}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_missing_or_unrecognized_flags() {
        assert!(parse_launch(["--unknown".into(), "value".into()]).is_err());
        assert!(parse_launch(["--cwd".into(), "C:\\work".into()]).is_err());
    }
    #[test]
    fn rejects_unsupported_profiles() {
        let mut args = vec![
            "--workspace-root".into(),
            "C:\\work".into(),
            "--codex-home".into(),
            "C:\\home".into(),
            "--cwd".into(),
            "C:\\work".into(),
            "--profile".into(),
            "full-access".into(),
            "--".into(),
            "cmd.exe".into(),
        ];
        assert!(parse_launch(args.clone()).is_err());
        args[7] = "workspace-online".into();
        #[cfg(windows)]
        assert!(parse_launch(args).is_ok());
    }
}
