use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Context;
use anyhow::Result;
use anyhow::anyhow;
use async_trait::async_trait;
use codex_network_proxy::ConfigReloader;
use codex_network_proxy::ConfigState;
use codex_network_proxy::NetworkMode;
use codex_network_proxy::NetworkProxy;
use codex_network_proxy::NetworkProxyConfig;
use codex_network_proxy::NetworkProxyConstraints;
use codex_network_proxy::NetworkProxyHandle;
use codex_network_proxy::NetworkProxyState;
use codex_network_proxy::build_config_state;
use codex_protocol::config_types::WindowsSandboxLevel;
use codex_protocol::models::PermissionProfile;
use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxEntry;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_protocol::permissions::FileSystemSpecialPath;
use codex_protocol::permissions::NetworkSandboxPolicy;
use codex_sandboxing::SandboxCommand;
use codex_sandboxing::SandboxManager;
use codex_sandboxing::SandboxTransformRequest;
use codex_sandboxing::SandboxType;
use codex_utils_absolute_path::AbsolutePathBuf;
use serde::Deserialize;
use serde::Serialize;

const PROTOCOL_VERSION: u8 = 1;
const DIM_CODEX_LINUX_SANDBOX_ENV: &str = "DIM_CODEX_LINUX_SANDBOX";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeRunnerRequest {
    version: u8,
    request_id: String,
    command: Vec<String>,
    cwd: PathBuf,
    #[serde(default)]
    env: HashMap<String, String>,
    policy: DimSandboxPolicy,
    #[allow(dead_code)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DimSandboxPolicy {
    enabled: bool,
    mode: String,
    workspace_root: PathBuf,
    #[serde(default)]
    readable_roots: Vec<PathBuf>,
    #[serde(default)]
    writable_roots: Vec<PathBuf>,
    #[serde(default)]
    read_deny_paths: Vec<String>,
    #[serde(default)]
    allowed_domains: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRunnerResult {
    version: u8,
    request_id: String,
    command: Vec<String>,
    cwd: PathBuf,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    signal: Option<String>,
    timed_out: bool,
    wall_time_ms: u128,
    backend: String,
    diagnostics: Vec<NativeRunnerDiagnostic>,
}

#[derive(Debug, Serialize)]
struct NativeRunnerDiagnostic {
    level: &'static str,
    code: &'static str,
    message: String,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run_main().await {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

async fn run_main() -> Result<()> {
    let request = read_request()?;
    if request.version != PROTOCOL_VERSION {
        return Err(anyhow!(
            "unsupported dim-sandbox runner protocol version: {}",
            request.version
        ));
    }
    if request.command.is_empty() {
        return Err(anyhow!("command is required"));
    }

    let started_at = Instant::now();
    let mut diagnostics = Vec::new();
    let output = run_sandboxed(&request, &mut diagnostics).await?;

    let result = NativeRunnerResult {
        version: PROTOCOL_VERSION,
        request_id: request.request_id,
        command: request.command,
        cwd: request.cwd,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        signal: signal_from_status(&output.status),
        timed_out: false,
        wall_time_ms: started_at.elapsed().as_millis(),
        backend: platform_backend_name().to_string(),
        diagnostics,
    };

    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

fn read_request() -> Result<NativeRunnerRequest> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .context("failed to read native runner request from stdin")?;
    serde_json::from_str(&input).context("failed to parse native runner request")
}

async fn run_sandboxed(
    request: &NativeRunnerRequest,
    diagnostics: &mut Vec<NativeRunnerDiagnostic>,
) -> Result<std::process::Output> {
    if !request.policy.enabled || is_full_access_policy(&request.policy) {
        return run_direct(request);
    }

    let managed_network = start_managed_network_proxy(&request.policy).await?;

    #[cfg(target_os = "windows")]
    {
        return run_windows_codex_sandbox(
            request,
            diagnostics,
            managed_network.as_ref().map(|network| &network.proxy),
        )
        .await;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let codex_command = transform_with_codex_sandboxing(
            request,
            diagnostics,
            managed_network.as_ref().map(|network| &network.proxy),
        )?;
        return run_transformed_command(&codex_command, request);
    }
}

fn transform_with_codex_sandboxing(
    request: &NativeRunnerRequest,
    diagnostics: &mut Vec<NativeRunnerDiagnostic>,
    network: Option<&NetworkProxy>,
) -> Result<codex_sandboxing::SandboxExecRequest> {
    let cwd = absolute(&request.cwd)?;
    let permission_profile =
        permission_profile_from_dim_policy(&request.policy, cwd.as_path(), diagnostics)?;
    let sandbox = platform_sandbox_type()?;
    let codex_linux_sandbox_exe = codex_linux_sandbox_helper();

    let command = SandboxCommand {
        program: OsString::from(request.command[0].clone()),
        args: request.command.iter().skip(1).cloned().collect(),
        cwd: cwd.clone(),
        env: request.env.clone(),
        additional_permissions: None,
    };

    SandboxManager::new()
        .transform(SandboxTransformRequest {
            command,
            permissions: &permission_profile,
            sandbox,
            enforce_managed_network: network.is_some(),
            network,
            sandbox_policy_cwd: cwd.as_path(),
            codex_linux_sandbox_exe: codex_linux_sandbox_exe.as_deref(),
            use_legacy_landlock: false,
            windows_sandbox_level: WindowsSandboxLevel::RestrictedToken,
            windows_sandbox_private_desktop: false,
        })
        .map_err(|error| anyhow!("{error}"))
}

fn run_transformed_command(
    exec_request: &codex_sandboxing::SandboxExecRequest,
    request: &NativeRunnerRequest,
) -> Result<std::process::Output> {
    let (program, args) = exec_request
        .command
        .split_first()
        .ok_or_else(|| anyhow!("codex sandbox transform returned an empty command"))?;

    let mut command = Command::new(program);
    command.args(args);
    command.current_dir(&request.cwd);
    command.env_clear();
    let mut env = exec_request.env.clone();
    if let Some(network) = exec_request.network.as_ref() {
        network.apply_to_env(&mut env);
    }
    command.envs(env);

    #[cfg(unix)]
    if let Some(arg0) = exec_request.arg0.as_ref() {
        use std::os::unix::process::CommandExt;
        command.arg0(arg0);
    }

    command
        .output()
        .context("failed to execute Codex-derived sandbox command")
}

fn run_direct(request: &NativeRunnerRequest) -> Result<std::process::Output> {
    let mut command = Command::new(&request.command[0]);
    command.args(request.command.iter().skip(1));
    command.current_dir(&request.cwd);
    command.envs(&request.env);
    command.output().context("failed to execute command")
}

#[cfg(target_os = "windows")]
async fn run_windows_codex_sandbox(
    request: &NativeRunnerRequest,
    diagnostics: &mut Vec<NativeRunnerDiagnostic>,
    network: Option<&NetworkProxy>,
) -> Result<std::process::Output> {
    use codex_windows_sandbox::spawn_windows_sandbox_session_legacy;

    let cwd = absolute(&request.cwd)?;
    let permission_profile =
        permission_profile_from_dim_policy(&request.policy, cwd.as_path(), diagnostics)?;
    let legacy_policy = permission_profile
        .to_legacy_sandbox_policy(cwd.as_path())
        .context("failed to convert permission profile to Codex Windows sandbox policy")?;
    let policy_json = serde_json::to_string(&legacy_policy)?;
    let codex_home = env::var_os("DIM_SANDBOX_CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            request
                .policy
                .workspace_root
                .join(".dim-sandbox")
                .join("codex-home")
        });

    let mut command_env = request.env.clone();
    if let Some(network) = network {
        network.apply_to_env(&mut command_env);
    }

    let spawned = spawn_windows_sandbox_session_legacy(
        &policy_json,
        cwd.as_path(),
        &codex_home,
        request.command.clone(),
        &request.cwd,
        command_env,
        request.timeout_ms,
        &[],
        &[],
        false,
        true,
        false,
    )
    .await
    .context("failed to spawn Codex Windows sandbox session")?;

    let mut stdout_rx = spawned.stdout_rx;
    let mut stderr_rx = spawned.stderr_rx;
    let mut exit_rx = spawned.exit_rx;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_open = true;
    let mut stderr_open = true;

    loop {
        tokio::select! {
            chunk = stdout_rx.recv(), if stdout_open => {
                if let Some(chunk) = chunk {
                    stdout.extend(chunk);
                } else {
                    stdout_open = false;
                }
            }
            chunk = stderr_rx.recv(), if stderr_open => {
                if let Some(chunk) = chunk {
                    stderr.extend(chunk);
                } else {
                    stderr_open = false;
                }
            }
            exit = &mut exit_rx => {
                let code = exit.unwrap_or(1);
                return Ok(output_from_parts(code, stdout, stderr));
            }
        }
    }
}

fn permission_profile_from_dim_policy(
    policy: &DimSandboxPolicy,
    cwd: &Path,
    diagnostics: &mut Vec<NativeRunnerDiagnostic>,
) -> Result<PermissionProfile> {
    let network = network_policy_from_dim_policy(policy, diagnostics);
    let mut fs = match policy.mode.as_str() {
        "read-only" => {
            let readable_roots =
                policy_roots_or_workspace(&policy.readable_roots, &policy.workspace_root)?;
            let mut entries = vec![FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Minimal,
                },
                access: FileSystemAccessMode::Read,
            }];
            entries.extend(
                readable_roots
                    .into_iter()
                    .map(|path| FileSystemSandboxEntry {
                        path: FileSystemPath::Path { path },
                        access: FileSystemAccessMode::Read,
                    }),
            );

            FileSystemSandboxPolicy::restricted(entries)
        }
        "workspace-write" => {
            let readable_roots =
                policy_roots_or_workspace(&policy.readable_roots, &policy.workspace_root)?;
            let writable_roots =
                policy_roots_or_workspace(&policy.writable_roots, &policy.workspace_root)?;

            let mut entries = vec![FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Minimal,
                },
                access: FileSystemAccessMode::Read,
            }];
            entries.extend(
                readable_roots
                    .into_iter()
                    .map(|path| FileSystemSandboxEntry {
                        path: FileSystemPath::Path { path },
                        access: FileSystemAccessMode::Read,
                    }),
            );
            entries.extend(
                writable_roots
                    .into_iter()
                    .map(|path| FileSystemSandboxEntry {
                        path: FileSystemPath::Path { path },
                        access: FileSystemAccessMode::Write,
                    }),
            );

            FileSystemSandboxPolicy::restricted(entries)
        }
        "danger-full-access" | "off" => full_file_access_policy(policy),
        mode => return Err(anyhow!("unsupported sandbox mode: {mode}")),
    };

    if !matches!(policy.mode.as_str(), "danger-full-access" | "off") {
        append_deny_read_entries(&mut fs, policy)?;
    }

    Ok(PermissionProfile::from_runtime_permissions(&fs, network)
        .materialize_project_roots_with_workspace_roots(&[AbsolutePathBuf::from_absolute_path(
            cwd,
        )?]))
}

fn full_file_access_policy(policy: &DimSandboxPolicy) -> FileSystemSandboxPolicy {
    if policy.allowed_domains.iter().any(|domain| domain == "*") {
        return FileSystemSandboxPolicy::unrestricted();
    }

    FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
        path: FileSystemPath::Special {
            value: FileSystemSpecialPath::Root,
        },
        access: FileSystemAccessMode::Write,
    }])
}

fn policy_roots_or_workspace(
    roots: &[PathBuf],
    workspace_root: &Path,
) -> Result<Vec<AbsolutePathBuf>> {
    if roots.is_empty() {
        return Ok(vec![absolute(workspace_root)?]);
    }

    roots.iter().map(absolute).collect::<Result<Vec<_>>>()
}

fn append_deny_read_entries(
    fs: &mut FileSystemSandboxPolicy,
    policy: &DimSandboxPolicy,
) -> Result<()> {
    for path in &policy.read_deny_paths {
        let sandbox_path = if path.contains('*') {
            FileSystemPath::GlobPattern {
                pattern: normalize_deny_glob(path),
            }
        } else {
            FileSystemPath::Path {
                path: absolute(resolve_policy_path(path, &policy.workspace_root))?,
            }
        };
        fs.entries.push(FileSystemSandboxEntry {
            path: sandbox_path,
            access: FileSystemAccessMode::Deny,
        });
    }
    Ok(())
}

fn resolve_policy_path(value: &str, base_dir: &Path) -> PathBuf {
    let expanded = expand_home_path(value);
    let path = PathBuf::from(expanded);
    if path.is_absolute() {
        path
    } else {
        base_dir.join(path)
    }
}

fn normalize_deny_glob(value: &str) -> String {
    let expanded = expand_home_path(value);
    if Path::new(&expanded).is_absolute() || expanded.starts_with("**/") {
        expanded
    } else {
        format!("**/{expanded}")
    }
}

fn expand_home_path(value: &str) -> String {
    if value == "~" {
        return home_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| value.to_string());
    }

    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }

    value.to_string()
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn network_policy_from_dim_policy(
    policy: &DimSandboxPolicy,
    _diagnostics: &mut Vec<NativeRunnerDiagnostic>,
) -> NetworkSandboxPolicy {
    if policy.allowed_domains.iter().any(|domain| domain == "*") {
        return NetworkSandboxPolicy::Enabled;
    }

    NetworkSandboxPolicy::Restricted
}

fn is_full_access_policy(policy: &DimSandboxPolicy) -> bool {
    matches!(policy.mode.as_str(), "off" | "danger-full-access")
        && policy.allowed_domains.iter().any(|domain| domain == "*")
}

struct StartedManagedNetworkProxy {
    proxy: NetworkProxy,
    _handle: NetworkProxyHandle,
}

#[derive(Clone)]
struct StaticNetworkProxyReloader {
    state: ConfigState,
}

#[async_trait]
impl ConfigReloader for StaticNetworkProxyReloader {
    fn source_label(&self) -> String {
        "dim-sandbox-runner".to_string()
    }

    async fn maybe_reload(&self) -> Result<Option<ConfigState>> {
        Ok(None)
    }

    async fn reload_now(&self) -> Result<ConfigState> {
        Ok(self.state.clone())
    }
}

async fn start_managed_network_proxy(
    policy: &DimSandboxPolicy,
) -> Result<Option<StartedManagedNetworkProxy>> {
    if policy.allowed_domains.is_empty()
        || policy.allowed_domains.iter().any(|domain| domain == "*")
    {
        return Ok(None);
    }

    let mut config = NetworkProxyConfig::default();
    config.network.enabled = true;
    config.network.mode = NetworkMode::Full;
    config.network.enable_socks5_udp = false;
    config.network.allow_upstream_proxy = false;
    config.network.allow_local_binding = true;
    config
        .network
        .set_allowed_domains(policy.allowed_domains.clone());

    let state = build_config_state(config, NetworkProxyConstraints::default())
        .context("failed to build Dim sandbox network proxy policy")?;
    let reloader = Arc::new(StaticNetworkProxyReloader {
        state: state.clone(),
    });
    let proxy = NetworkProxy::builder()
        .state(Arc::new(NetworkProxyState::with_reloader(state, reloader)))
        .build()
        .await
        .context("failed to build Dim sandbox network proxy")?;
    let handle = proxy
        .run()
        .await
        .context("failed to start Dim sandbox network proxy")?;

    Ok(Some(StartedManagedNetworkProxy {
        proxy,
        _handle: handle,
    }))
}

fn absolute(path: impl AsRef<Path>) -> Result<AbsolutePathBuf> {
    AbsolutePathBuf::from_absolute_path(path).context("failed to normalize absolute path")
}

fn codex_linux_sandbox_helper() -> Option<PathBuf> {
    if let Some(path) = env::var_os(DIM_CODEX_LINUX_SANDBOX_ENV) {
        return Some(PathBuf::from(path));
    }

    let current_exe = env::current_exe().ok()?;
    let sibling = current_exe.parent()?.join("codex-linux-sandbox");
    sibling.exists().then_some(sibling)
}

fn platform_sandbox_type() -> Result<SandboxType> {
    if cfg!(target_os = "macos") {
        Ok(SandboxType::MacosSeatbelt)
    } else if cfg!(target_os = "linux") {
        Ok(SandboxType::LinuxSeccomp)
    } else {
        Err(anyhow!(
            "native Codex-derived sandbox is not supported on this platform"
        ))
    }
}

fn platform_backend_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "codex-derived-macos-seatbelt"
    } else if cfg!(target_os = "linux") {
        "codex-derived-linux-bwrap"
    } else if cfg!(target_os = "windows") {
        "codex-derived-windows-restricted-token"
    } else {
        "codex-derived-unsupported"
    }
}

fn signal_from_status(status: &std::process::ExitStatus) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        return status.signal().map(|signal| signal.to_string());
    }

    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

#[cfg(target_os = "windows")]
fn output_from_parts(code: i32, stdout: Vec<u8>, stderr: Vec<u8>) -> std::process::Output {
    use std::os::windows::process::ExitStatusExt;

    std::process::Output {
        status: std::process::ExitStatus::from_raw(code as u32),
        stdout,
        stderr,
    }
}
