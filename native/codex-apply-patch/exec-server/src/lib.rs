//! CCM filesystem transport for the unmodified upstream codex-apply-patch crate.
//! The upstream codex-exec-server exports these types from codex-file-system;
//! embedding the full exec-server (network, RPC, sandbox runtime) in CCM would
//! introduce a second executor. Only the FileSystem calls used by apply-patch
//! are implemented here; authorization belongs at this Worker filesystem edge.

use codex_utils_path_uri::PathUri;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, LazyLock};

pub type ExecutorFileSystemFuture<'a, T> =
    Pin<Box<dyn Future<Output = io::Result<T>> + Send + 'a>>;

#[derive(Clone, Copy, Default)]
pub struct ReadFileOptions {
    pub follow_symlinks: bool,
}
#[derive(Clone, Copy, Default)]
pub struct WriteFileOptions {
    pub follow_symlinks: bool,
}
#[derive(Clone, Copy, Default)]
pub struct GetMetadataOptions {
    pub follow_symlinks: bool,
}
#[derive(Clone, Copy)]
pub struct RemoveOptions {
    pub recursive: bool,
    pub force: bool,
    pub follow_symlinks: bool,
}
#[derive(Clone, Copy)]
pub struct CreateDirectoryOptions {
    pub recursive: bool,
    pub follow_symlinks: bool,
}
pub struct FileMetadata {
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symlink: bool,
}

/// The CCM workspace-write boundary, passed to every filesystem operation.
/// The original Codex patch parser and patch application receive this context
/// unchanged, including for source reads and partial multi-hunk failures.
pub struct FileSystemSandboxContext {
    lexical_roots: Vec<PathBuf>,
    canonical_roots: Vec<PathBuf>,
}

impl FileSystemSandboxContext {
    pub fn new(roots: &[PathBuf]) -> io::Result<Self> {
        if roots.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "workspace-write requires a workspace root",
            ));
        }
        let canonical_roots = roots
            .iter()
            .map(std::fs::canonicalize)
            .collect::<io::Result<Vec<_>>>()?;
        Ok(Self {
            lexical_roots: roots.to_vec(),
            canonical_roots,
        })
    }

    fn check(&self, path: &Path) -> io::Result<()> {
        if !self.lexical_roots.iter().any(|root| is_within(root, path)) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("workspace-write forbids path outside workspace roots: {}", path.display()),
            ));
        }
        // Walk to an existing ancestor, so junction/symlink escapes are also
        // rejected for new files and directories. On Windows canonical paths
        // have extended-path prefixes; compare normalized complete components
        // rather than arbitrary substrings.
        let mut existing = path.to_path_buf();
        loop {
            match existing.symlink_metadata() {
                Ok(_) => break,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if !existing.pop() {
                        return Err(io::Error::new(io::ErrorKind::NotFound, "no existing ancestor"));
                    }
                }
                Err(error) => return Err(error),
            }
        }
        let resolved = existing.canonicalize()?;
        if self
            .canonical_roots
            .iter()
            .any(|root| is_within(root, &resolved))
        {
            return Ok(());
        }
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("workspace-write forbids path outside workspace roots: {}", path.display()),
        ))
    }
}

fn is_within(root: &Path, path: &Path) -> bool {
    #[cfg(windows)]
    {
        let root = root.to_string_lossy().replace('\\', "/").to_lowercase();
        let path = path.to_string_lossy().replace('\\', "/").to_lowercase();
        let root = root.trim_end_matches('/');
        path == root || path.starts_with(&format!("{root}/"))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
}

fn checked_path(path: &PathUri, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<PathBuf> {
    let native = path.to_abs_path()?.to_path_buf();
    if let Some(sandbox) = sandbox {
        sandbox.check(&native)?;
    }
    Ok(native)
}

pub trait ExecutorFileSystem: Send + Sync {
    fn read_file_text<'a>(
        &'a self, path: &'a PathUri, options: ReadFileOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, String>;
    fn write_file<'a>(
        &'a self, path: &'a PathUri, contents: Vec<u8>, options: WriteFileOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>;
    fn get_metadata<'a>(
        &'a self, path: &'a PathUri, options: GetMetadataOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>;
    fn remove<'a>(
        &'a self, path: &'a PathUri, options: RemoveOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>;
    fn create_directory<'a>(
        &'a self, path: &'a PathUri, options: CreateDirectoryOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>;
}

pub static LOCAL_FS: LazyLock<Arc<dyn ExecutorFileSystem>> =
    LazyLock::new(|| Arc::new(CcmFileSystem));

struct CcmFileSystem;

impl ExecutorFileSystem for CcmFileSystem {
    fn read_file_text<'a>(
        &'a self, path: &'a PathUri, options: ReadFileOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, String> {
        Box::pin(async move {
            let path = checked_path(path, sandbox)?;
            if !options.follow_symlinks && path.symlink_metadata()?.file_type().is_symlink() {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "symlink not followed"));
            }
            tokio::fs::read_to_string(path).await
        })
    }
    fn write_file<'a>(
        &'a self, path: &'a PathUri, contents: Vec<u8>, options: WriteFileOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(async move {
            let path = checked_path(path, sandbox)?;
            if !options.follow_symlinks && path.is_symlink() {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "symlink not followed"));
            }
            tokio::fs::write(path, contents).await
        })
    }
    fn get_metadata<'a>(
        &'a self, path: &'a PathUri, options: GetMetadataOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata> {
        Box::pin(async move {
            let path = checked_path(path, sandbox)?;
            let metadata = if options.follow_symlinks {
                tokio::fs::metadata(&path).await?
            } else {
                tokio::fs::symlink_metadata(&path).await?
            };
            Ok(FileMetadata {
                is_directory: metadata.is_dir(),
                is_file: metadata.is_file(),
                is_symlink: metadata.file_type().is_symlink(),
            })
        })
    }
    fn remove<'a>(
        &'a self, path: &'a PathUri, options: RemoveOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(async move {
            let path = checked_path(path, sandbox)?;
            let metadata = tokio::fs::symlink_metadata(&path).await;
            if metadata.is_err() && options.force && metadata.as_ref().err().is_some_and(|e| e.kind() == io::ErrorKind::NotFound) {
                return Ok(());
            }
            let metadata = metadata?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                if options.recursive {
                    tokio::fs::remove_dir_all(path).await
                } else {
                    tokio::fs::remove_dir(path).await
                }
            } else {
                tokio::fs::remove_file(path).await
            }
        })
    }
    fn create_directory<'a>(
        &'a self, path: &'a PathUri, options: CreateDirectoryOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(async move {
            let path = checked_path(path, sandbox)?;
            if options.recursive {
                tokio::fs::create_dir_all(path).await
            } else {
                tokio::fs::create_dir(path).await
            }
        })
    }
}
