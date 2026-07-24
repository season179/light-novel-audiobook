# ADR 0001: WSL2 runtime, storage, SQLite, and Portless topology

- Status: Accepted
- Date: 2026-07-24
- Issue: [#2](https://github.com/season179/light-novel-audiobook/issues/2)
- Evidence: [`../evidence/issue-2-topology-wsl2.json`](../evidence/issue-2-topology-wsl2.json)

## Context

The application needs one local launcher, concurrent web and worker access to SQLite, two isolated model servers, stable browser names, large Windows-visible workspaces, and safe recovery after interruption. The supported execution environment is WSL2. SQLite behavior over WSL ext4 and the `/mnt/c` 9p/DrvFS mount had to be measured rather than assumed.

The committed probe uses the issue #1 native Linux Node.js toolchain and temporary synthetic data only. It does not download books, voices, models, or inference engines.

## Decision

### Process ownership

All application and inference processes run inside the same Ubuntu WSL2 distribution. Windows runs only the browser.

| Component | Environment and OS owner | Lifecycle owner | State owner |
| --- | --- | --- | --- |
| Launcher | WSL2, normal Linux user | User invokes one launcher command | Runtime manifest and lock |
| Portless proxy | WSL2; root only when required to bind HTTPS port 443 | Launcher invokes `portless proxy start/stop` | Dedicated Portless state directory on ext4 |
| Web app | WSL2, normal Linux user, separate Node process | Launcher | SQLite plus workspace files |
| Worker | WSL2, normal Linux user, separate Node process | Launcher | SQLite leases/heartbeats plus workspace files |
| SQLite | In-process library, not a server process | Web/worker connections under application transaction rules | One ext4 database |
| Brain router | WSL2, normal Linux user, separate standard `llama.cpp` process and install directory | Launcher | Runtime manifest; model files on ext4 |
| TTS server | WSL2, normal Linux user, separate `llama.cpp-omni` process and install directory | Launcher | Runtime manifest; model files on ext4 |
| Browser | Windows host | User | No authoritative state |

The launcher must hold an exclusive `flock` for its instance. It starts each child directly, so Portless does not own application or model-server children. Portless aliases route to already-started children. This avoids Portless's worktree hostname prefix and preserves the required exact route names.

Each process record is atomically written and contains at least:

- launcher instance/owner token;
- service name and lifecycle state;
- PID and Linux `/proc/<pid>/stat` start-time ticks;
- executable/config identity;
- loopback address and dynamically allocated port;
- direct URL and Portless route;
- start time and last health observation.

A PID alone is never proof of ownership. Stop or cleanup may signal a process only when both PID and start-time ticks still match the launch record. A mismatch is stale state and must not be killed. Graceful stop sends `SIGTERM`, waits a bounded time for checkpoint/exit, and only then sends `SIGKILL` to a still-matching owned process. Restart replaces stale records and Portless aliases atomically.

### Filesystem placement

SQLite and operational state live on WSL ext4:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/light-novel-audiobook/state.sqlite3
${XDG_DATA_HOME:-$HOME/.local/share}/light-novel-audiobook/backups/
${XDG_STATE_HOME:-$HOME/.local/state}/light-novel-audiobook/
${XDG_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}}/light-novel-audiobook/run/
```

Portless receives an explicit state directory below the application state directory. Brain and TTS source trees, binaries, and weights also remain on ext4 and stay isolated from one another.

Large per-book assets may live under a user-selected `/mnt/c/...` workspace. This includes source EPUBs, extracted assets, reference voices, clips, chapter masters, and exports. Temporary high-I/O render products should prefer ext4 when space allows, then be durably copied into the workspace. Git continues to exclude databases, workspaces, models, books, and audio.

Both candidate filesystems passed the synthetic SQLite safety probe. Ext4 is nevertheless selected for the database because it provides native Linux locking and rename semantics, avoids a 9p/DrvFS boundary, and was faster in this run (604 ms versus 771 ms). Passing one mounted-volume probe is not a guarantee across Windows, WSL, antivirus, or mount-option updates. Keeping only large assets on `/mnt/c` gives Windows visibility without putting the source-of-truth database there.

### SQLite policy

The persistence adapter must apply and verify the following on every connection:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

Transactions must be short. A worker claim uses a brief write transaction and performs no model inference or filesystem rendering while holding the write lock. Busy responses beyond the bounded timeout are reported/retried; they are not treated as successful work.

Use SQLite's online backup API before each migration. Open the completed backup and run `PRAGMA integrity_check` before migration proceeds. Normal updates use SQLite transactions. Never replace an open database file and never rename a database independently of live `-wal` or `-shm` files. The tested durable rename procedure—fsync the completed replacement, rename, then fsync the parent directory—is allowed only for a validated, closed database with all handles closed and sidecars absent, such as an offline restore.

The probe demonstrated:

- one writer excludes a second writer;
- a zero busy timeout fails while a 2-second timeout waits for a 300 ms lock and succeeds;
- WAL and rollback journal selection;
- consistent online backup and integrity validation;
- durable closed-database replacement;
- rollback of an uncommitted transaction after `SIGKILL` in DELETE journal mode;
- recovery of a committed transaction after `SIGKILL` in WAL mode;
- successful integrity checks after both crash cases.

These are integration tests, not a claim that a synthetic kill reproduces power loss through every storage cache. Backups remain required.

### Canonical paths

Configuration uses absolute Linux POSIX paths as seen inside WSL2. Do not store `C:\...` syntax and do not silently translate paths. The example workspace is therefore `/mnt/c/Users/WINDOWS 11/Audiobooks`.

SQLite asset records use normalized workspace-relative POSIX paths such as `books/<book-id>/source/book.epub`. They must reject absolute paths, backslashes, NUL, and `..` traversal. Resolve the configured workspace root once to its canonical absolute path; after joining a relative record, verify that the result remains below that root. This keeps a workspace movable without rewriting every database row.

Runtime directories, database locations, inference installs, and model paths are absolute canonical WSL paths. Dynamic direct URLs and PID-file paths belong only in the runtime manifest, not in durable domain records.

### Ports, Portless, and binding

Every web/model control endpoint binds explicitly to `127.0.0.1`, never `0.0.0.0`. Portless normal mode binds its proxy only to `127.0.0.1` and `::1`; LAN, Tailscale, Funnel, ngrok, wildcard, and mDNS/LAN modes are disabled.

The launcher requests an ephemeral loopback port from the Linux kernel, starts the child on it, confirms the listener and health identity, and records the actual port. If a server cannot inherit a reserved socket, startup retries a bind race rather than falling back to a hardcoded port. The launcher then installs these exact aliases:

- `audiobook` -> `audiobook.localhost`;
- `brain.audiobook` -> `brain.audiobook.localhost`;
- `tts.audiobook` -> `tts.audiobook.localhost`.

Application configuration uses the named routes. The runtime manifest and `portless list` expose direct ports for troubleshooting. Portless `run` remains convenient for ad hoc development, but the future launcher must use explicit aliases because `run` deliberately prefixes linked-worktree branch names.

The repeatable probe assigned distinct dynamic backend ports, verified routed and direct responses, inspected listeners with Linux `ss`, and failed connection attempts through WSL's `172.27.141.239` LAN address. A Windows Chrome headless screenshot check loaded all three `.localhost` hostnames through WSL localhost forwarding and asserted a service-specific response color.

The recorded browser proof used isolated HTTP Portless state on an unprivileged high proxy port. Production development uses Portless's normal HTTPS route. Binding 443 and installing/trusting the CA are one-time interactive host setup checks described under unresolved checks.

### Effective machine constraints

The evidence captured these effective WSL values:

- Ubuntu on WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`;
- 57,587,864 kB (about 54.9 GiB) visible RAM;
- 16 GiB swap;
- 16 visible CPUs;
- NVIDIA GeForce RTX 5070 Ti with 16,303 MiB reported VRAM, driver 610.74, `/dev/dxg` visible;
- ext4: about 941 GiB free at capture time;
- `/mnt/c`: about 1.6 TiB free at capture time;
- `.wslconfig`: `memory=56GB`, `swap=16GB`.

No `.wslconfig` change is required for this topology spike. Runtime preflight and later model benchmarks must use the effective 54.9 GiB value, not assume all 64 GB of host RAM is available. Keep the existing Windows reserve. Consider `memory=60GB` only if representative model benchmarks prove 56 GB insufficient and the user accepts less Windows headroom; such a change requires a Windows-side WSL shutdown/restart and is not made here.

## Repeatable verification

Run the committed integration tests with the issue #1 toolchain:

```sh
export PATH="$HOME/.local/share/light-novel-audiobook/toolchain/current/bin:$PATH"
pnpm test:topology
```

Capture a fresh host report, including the explicit Windows-browser check:

```sh
TOPOLOGY_WINDOWS_BROWSER='/mnt/c/Program Files/Google/Chrome/Application/chrome.exe' \
  pnpm probe:topology --output docs/evidence/issue-2-topology-wsl2.json
```

Without `TOPOLOGY_WINDOWS_BROWSER`, the probe records the browser check as not run. Temporary databases, Portless state, processes, aliases, profiles, and screenshots are cleaned up. The normal test suite covers native/ext4 and `/mnt/c` SQLite behavior when `/mnt/c` is available, path rejection, atomic state writes, PID identity, dynamic ports, route replacement, graceful stop, and loopback/LAN isolation.

## Consequences and tradeoffs

- The database is not automatically portable with a Windows workspace. Export/import and tested backups provide portability instead.
- Ext4 state depends on the WSL distribution/VHD being backed up appropriately.
- Multiple application processes can share SQLite safely, but there remains one writer at a time.
- Exact stable names are independent of backend ports and Git worktree names.
- The launcher must manage Portless aliases and process identity instead of delegating child ownership to `portless run`.
- Root elevation may be needed for the normal HTTPS proxy on port 443, while application/model children remain unprivileged.
- Windows does not own or directly manipulate Linux PIDs, SQLite, model files, or runtime manifests.

## Unresolved environmental checks

These do not change the selected topology but must be completed on the target host before launcher acceptance:

1. Start the normal Portless HTTPS proxy interactively on port 443, run `portless trust`, restart Windows Chrome if needed, and repeat all three browser URLs without an explicit proxy port. This spike had no non-interactive sudo credential and intentionally did not modify host trust stores.
2. Repeat the probe after changes to WSL networking mode, Portless version, Windows browser, antivirus policy, or `/mnt/c` mount behavior.
3. Validate the eventual real `llama.cpp` and `llama.cpp-omni` binaries accept the assigned loopback addresses/ports and stop within the launcher grace period. No models or inference engines were downloaded in this spike.
4. Measure model RAM, swap, VRAM, and throughput under representative load. GPU visibility is proven; inference capacity is not.
5. Define and test the user's ext4/VHD backup policy before irreplaceable production review state is created.
