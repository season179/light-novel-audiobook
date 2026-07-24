# ADR 0001: WSL2 runtime, storage, SQLite, and direct-loopback topology

- Status: **Accepted**
- Date: 2026-07-24
- Revised: 2026-07-24 after the direct-port milestone decision
- Issue: [#2](https://github.com/season179/light-novel-audiobook/issues/2)
- Evidence: [`../evidence/issue-2-topology-wsl2.json`](../evidence/issue-2-topology-wsl2.json)

## Context

The application needs one local launcher, concurrent web and worker access to SQLite, two isolated model servers, safe restart behavior, and Windows-browser access to a WSL-hosted review app. The current milestone favors the smallest unprivileged topology: direct HTTP listeners on stable loopback ports, with no routing proxy, TLS, certificate authority, or elevation.

The committed probe uses the issue #1 native Linux Node.js toolchain and temporary synthetic data only. It downloads no books, voices, models, or inference engines.

## Decision

### Fixed direct endpoints

The current defaults are:

| Service | WSL listen/base endpoint | User-facing endpoint |
| --- | --- | --- |
| Review app | `http://127.0.0.1:3000` | `http://localhost:3000` |
| Brain router | `http://127.0.0.1:8080/v1` | same |
| TTS server | `http://127.0.0.1:8081` | same |

Ports are configurable, but startup never silently substitutes another port. The launcher binds each configured endpoint directly and fails closed on `EADDRINUSE`. All listeners are unprivileged plain HTTP and bind only to `127.0.0.1`, never `0.0.0.0` or a LAN address.

The review app displays `http://localhost:3000` because Windows-to-WSL localhost forwarding makes that the convenient browser form. Service-to-service configuration uses explicit `127.0.0.1` URLs.

Portless, previously considered as a named local routing proxy, is deferred. It may be reconsidered after the launcher and core runtime work reliably, but it is not a dependency, script, process, or acceptance requirement for this milestone.

### Process ownership and runtime manifest

All application and inference processes run inside the same Ubuntu WSL2 distribution as the normal Linux user. Windows runs only the browser.

| Component | Environment | Lifecycle owner |
| --- | --- | --- |
| Launcher | WSL2 normal user | User invokes one launcher command |
| Web app | Separate WSL2 Node process | Launcher |
| Worker | Separate WSL2 Node process | Launcher |
| SQLite | In-process library | Web/worker transaction policy |
| Brain router | Separate standard `llama.cpp` WSL2 process/install | Launcher |
| TTS server | Separate `llama.cpp-omni` WSL2 process/install | Launcher |
| Browser | Windows host | User |

The launcher holds an exclusive `flock`. Every process record contains:

- launcher owner token and service name;
- PID and `/proc/<pid>/stat` start-time ticks;
- canonical executable path, device/inode, and command-line hash;
- configured host/port and effective endpoint;
- lifecycle state and health observation.

A child must echo its owner token over startup IPC and a loopback health-response header before it is accepted. Stop or cleanup may signal a process only when all recorded process identity fields still match. A mismatch is stale state and must not be killed. Graceful stop sends `SIGTERM`, waits a bounded time, and uses `SIGKILL` only for the same still-owned process.

After startup and every restart, the launcher atomically writes one runtime manifest using write, fsync, rename, and parent-directory fsync. It records the configured/effective endpoints and full runtime process identities. The probe reads the completed manifest back, verifies generation advancement after restart, and proves the review service reclaims the same configured port.

### Filesystem placement

SQLite and operational state live on WSL ext4:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/light-novel-audiobook/state.sqlite3
${XDG_DATA_HOME:-$HOME/.local/share}/light-novel-audiobook/backups/
${XDG_STATE_HOME:-$HOME/.local/state}/light-novel-audiobook/
${XDG_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}}/light-novel-audiobook/run/
```

Brain and TTS source trees, binaries, and weights also remain on ext4 and stay isolated from one another. Large per-book assets may live under a user-selected `/mnt/<drive>/...` workspace.

Before filesystem experiments, `findmnt` must prove that the ext4 candidate is actually ext4 and that the mounted-Windows candidate is an explicit `/mnt/<drive>` DrvFS/9p path. Canonicalizing a symlink into ext4 or defaulting an ext4 checkout to the mounted candidate is rejected.

Both candidates passed the synthetic SQLite probe. Ext4 remains selected for the source-of-truth database because it supplies native Linux locking and rename semantics and avoids the 9p/DrvFS boundary. Large assets can remain Windows-visible without placing SQLite there.

### SQLite policy

Every persistence connection must apply and verify:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

Transactions stay short; inference and rendering never occur while a write transaction is held. Use SQLite's online backup API before every migration, then open the completed backup and require `PRAGMA integrity_check` to return `ok` before proceeding.

Never replace an open database or rename it independently of live `-wal`/`-shm` files. Durable replacement is allowed only for a validated closed database with all handles closed and sidecars absent.

The committed ext4 and mounted-Windows probes demonstrate:

- writer locking and bounded busy waiting;
- WAL and rollback journal behavior;
- online backup plus full `integrity_check`;
- durable closed-database replacement;
- rollback of uncommitted DELETE-journal work after `SIGKILL`;
- recovery of committed WAL work after `SIGKILL`;
- post-crash integrity checks.

### Canonical paths

Configuration uses absolute Linux POSIX paths as seen inside WSL2, never `C:\...` syntax. SQLite stores normalized workspace-relative POSIX paths such as `books/<book-id>/source/book.epub` and rejects absolute paths, backslashes, NUL, and `..` traversal.

Resolve the configured workspace root once. For each existing target—or the nearest existing ancestor of a future target—resolve symlinks before containment checks. This prevents a path that looks lexically internal from escaping through a symlink.

Runtime directories, database locations, inference installs, and model paths are absolute canonical WSL paths. Runtime endpoints and process records belong in the runtime manifest, not durable domain records.

## Evidence and acceptance

The repeatable direct-network probe:

1. binds the configured fixed ports and verifies owner-token health responses;
2. attempts a second bind and requires fail-closed `EADDRINUSE` behavior;
3. atomically records and reads back the effective endpoints;
4. gracefully stops and restarts the review process on the same port;
5. reruns `ss` checks against the final processes and proves every listener is `127.0.0.1` only;
6. attempts every final port through the WSL LAN address and requires all attempts to fail;
7. invokes Windows Chrome directly, without PowerShell, CMD, or another shell wrapper, and verifies `http://localhost:3000` renders the expected service response.

Committed evidence is redacted: no user paths, host-specific/LAN IP addresses, PIDs, owner tokens, temporary paths, or full `.wslconfig` content. The configured `127.0.0.1` endpoints are intentionally retained. It retains the generating commit, probe source hash/version, browser version, configured endpoints, and reproducible command.

Run the integration tests and host probe with the issue #1 toolchain:

```sh
export PATH="$HOME/.local/share/light-novel-audiobook/toolchain/current/bin:$PATH"
pnpm test:topology

TOPOLOGY_WINDOWS_BROWSER='/mnt/c/Program Files/Google/Chrome/Application/chrome.exe' \
  pnpm probe:topology --output docs/evidence/issue-2-topology-wsl2.json
```

The host probe fails rather than changing ports when 3000, 8080, or 8081 is occupied.

## Effective machine constraints

The evidence records effective WSL RAM, swap, CPUs, ext4 and mounted-volume capacity, and GPU visibility. On the measured host, WSL sees about 54.9 GiB RAM, 16 GiB swap, 16 CPUs, and an RTX 5070 Ti with about 16 GiB VRAM. `.wslconfig` contributes `memory=56GB` and `swap=16GB`; the committed evidence records only those relevant parsed settings, not the full file or its path.

No `.wslconfig` change is required for this topology. Later representative model benchmarks must use effective WSL limits rather than assuming all host RAM is available.

## Consequences

- The current runtime has visible stable port numbers and no friendly named routes.
- Port conflicts produce an actionable startup error instead of hidden reassignment.
- There is no local TLS or CA lifecycle to install, trust, elevate, or debug.
- The database is not automatically portable with a Windows workspace; tested backups and exports provide portability.
- SQLite still has one writer at a time.
- Windows does not own or manipulate Linux PIDs, SQLite, model files, or runtime manifests.

## Remaining non-blocking environmental work

- Validate the eventual real `llama.cpp` and `llama.cpp-omni` binaries bind the configured addresses, report health, and stop within the launcher grace period.
- Measure representative model RAM, swap, VRAM, and throughput.
- Define and test the user's ext4/VHD backup policy before irreplaceable review state is created.
- Reconsider named local routing only after core launcher behavior is stable and only through a separate decision.
