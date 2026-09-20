use anyhow::{Context, Result, bail};
use portable_pty::{CommandBuilder, PtySize, PtySystem};
use std::env;

#[cfg(windows)]
mod win;
#[cfg(windows)]
mod windows_input;

fn platform_native_pty_system() -> Box<dyn PtySystem + Send> {
    #[cfg(windows)]
    {
        Box::new(win::ConPtySystem::default())
    }

    #[cfg(not(windows))]
    {
        portable_pty::native_pty_system()
    }
}
use std::io::{Read, Write};
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

struct Options {
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    program: String,
    args: Vec<String>,
}

fn parse_args() -> Result<Options> {
    let mut argv = env::args().skip(1);
    let mut cwd = env::current_dir()?;
    let mut cols = 120u16;
    let mut rows = 30u16;
    let mut command = Vec::new();

    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--cwd" => cwd = PathBuf::from(argv.next().context("--cwd requires a value")?),
            "--cols" => cols = argv.next().context("--cols requires a value")?.parse()?,
            "--rows" => rows = argv.next().context("--rows requires a value")?.parse()?,
            "--" => {
                command.extend(argv);
                break;
            }
            other => bail!("unknown argument: {other}"),
        }
    }

    let Some(program) = command.first().cloned() else {
        bail!("missing command after --");
    };

    Ok(Options {
        cwd,
        cols,
        rows,
        program,
        args: command.into_iter().skip(1).collect(),
    })
}

fn run() -> Result<i32> {
    let options = parse_args()?;
    let pty_system = platform_native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: options.rows,
        cols: options.cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut command = CommandBuilder::new(&options.program);
    command.cwd(&options.cwd);
    for arg in &options.args {
        command.arg(arg);
    }
    for (key, value) in env::vars() {
        command.env(key, value);
    }

    let mut child = pair
        .slave
        .spawn_command(command)
        .with_context(|| format!("failed to spawn {}", options.program))?;

    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;

    thread::spawn(move || {
        let mut stdout = std::io::stdout().lock();
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if stdout.write_all(&buffer[..n]).is_err() {
                        break;
                    }
                    let _ = stdout.flush();
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });

    thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buffer = [0u8; 8192];
        #[cfg(windows)]
        let mut normalizer = windows_input::WindowsTtyInputNormalizer::default();

        loop {
            match stdin.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    #[cfg(windows)]
                    let input = normalizer.normalize(&buffer[..n]);
                    #[cfg(not(windows))]
                    let input = buffer[..n].to_vec();

                    if writer.write_all(&input).is_err() {
                        break;
                    }
                    let _ = writer.flush();
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });

    let status = child.wait()?;
    let exit_code = status.exit_code() as i32;
    thread::sleep(Duration::from_millis(50));
    Ok(exit_code)
}

fn main() {
    let code = match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("CCM PTY proxy error: {error:#}");
            125
        }
    };
    std::process::exit(code);
}
