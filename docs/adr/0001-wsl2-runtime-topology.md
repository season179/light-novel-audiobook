# ADR 0001: WSL2 runtime, storage, SQLite, and Portless topology

- Status: **Blocked pending exact HTTPS/Windows-browser acceptance**
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
- canonical `/proc/<pid>/exe` path, executable device/inode, and command-line hash;
- executable/config identity;
- loopback address and dynamically allocated port;
- direct URL and Portless route;
- start time and last health observation.

A PID alone is never proof of ownership. Stop or cleanup may signal a process only when PID, start-time ticks, executable path/device/inode, and command-line hash still match the launch record. The launcher supplies a random owner token to each child; the child must echo it over startup IPC and a loopback health-response header before registration. Tokens are runtime secrets and are never committed. Any identity mismatch is stale state and must not be killed. Graceful stop sends `SIGTERM`, waits a bounded time for checkpoint/exit, and only then sends `SIGKILL` to a still-matching owned process. Restart replaces stale records and Portless aliases atomically.

### Filesystem placement

SQLite and operational state live on WSL ext4:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/light-novel-audiobook/state.sqlite3
${XDG_DATA_HOME:-$HOME/.local/share}/light-novel-audiobook/backups/
${XDG_STATE_HOME:-$HOME/.local/state}/light-novel-audiobook/
${XDG_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}}/light-novel-audiobook/run/
```

Portless receives an explicit state directory below the application state directory. Brain and TTS source trees, binaries, and weights also remain on ext4 and stay isolated from one another.

Large per-book assets may live under a user-selected `/mnt/<drive>/...` workspace. This includes source EPUBs, extracted assets, reference voices, clips, chapter masters, and exports. Temporary high-I/O render products should prefer ext4 when space allows, then be durably copied into the workspace. Git continues to exclude databases, workspaces, models, books, and audio.

Both candidate filesystems passed the synthetic SQLite safety probe. Before either run, `findmnt` must prove that the ext4 candidate is actually ext4 and that the mounted-Windows candidate is an explicit `/mnt/<drive>` DrvFS/9p path. Canonicalizing a symlink into ext4 or defaulting an ext4 checkout to the mounted candidate is rejected. Ext4 is nevertheless selected for the database because it provides native Linux locking and rename semantics and avoids a 9p/DrvFS boundary. Passing one mounted-volume probe is not a guarantee across Windows, WSL, antivirus, or mount-option updates. Keeping only large assets on `/mnt/c` gives Windows visibility without putting the source-of-truth database there.

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

Configuration uses absolute Linux POSIX paths as seen inside WSL2. Do not store `C:\...` syntax and do not silently translate paths. An example workspace is `/mnt/c/Users/<windows-user>/Audiobooks`.

SQLite asset records use normalized workspace-relative POSIX paths such as `books/<book-id>/source/book.epub`. They must reject absolute paths, backslashes, NUL, and `..` traversal. Resolve the configured workspace root once to its canonical absolute path. Resolve every existing target—or the nearest existing ancestor for a future target—before checking containment, so a symlink cannot escape the root. This keeps a workspace movable without rewriting every database row.

Runtime directories, database locations, inference installs, and model paths are absolute canonical WSL paths. Dynamic direct URLs and PID-file paths belong only in the runtime manifest, not in durable domain records.

### Ports, Portless, and binding

Every web/model control endpoint binds explicitly to `127.0.0.1`, never `0.0.0.0`. Portless normal mode binds its proxy only to `127.0.0.1` and `::1`; LAN, Tailscale, Funnel, ngrok, wildcard, and mDNS/LAN modes are disabled.

The launcher requests an ephemeral loopback port from the Linux kernel, starts the child on it, confirms the listener and health identity, and records the actual port. If a server cannot inherit a reserved socket, startup retries a bind race rather than falling back to a hardcoded port. The launcher then installs these exact aliases:

- `audiobook` -> `audiobook.localhost`;
- `brain.audiobook` -> `brain.audiobook.localhost`;
- `tts.audiobook` -> `tts.audiobook.localhost`.

Application configuration uses the named routes. The runtime manifest and `portless list` expose direct ports for troubleshooting. Portless `run` remains convenient for ad hoc development, but the future launcher must use explicit aliases because `run` deliberately prefixes linked-worktree branch names.

The repeatable synthetic harness assigns distinct dynamic backend ports, verifies owner-token routed and direct responses, restarts and re-aliases the web process, and only then reruns Linux `ss` listener checks and LAN-address connection failures against the final ports. It uses isolated HTTP Portless state on an unprivileged high proxy port and never invokes Windows Chrome. This proves dynamic routing, restart, and isolation mechanics, but it is not the configured HTTPS acceptance check.

Acceptance additionally requires the exact URLs `https://audiobook.localhost`, `https://brain.audiobook.localhost`, and `https://tts.audiobook.localhost` on loopback port 443. Linux `curl` must pass without `--insecure`, and Windows Chrome must render service-specific screenshots without a certificate interstitial or TLS bypass. The committed evidence reports this acceptance as blocked because no Portless proxy is listening on 443 and non-interactive sudo is unavailable. The earlier high-port HTTP browser run is explicitly not accepted as proof of HTTPS, trust, or port-443 behavior.

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

Capture a redacted host report and explicitly request the exact HTTPS acceptance:

```sh
TOPOLOGY_WINDOWS_BROWSER='/mnt/c/Program Files/Google/Chrome/Application/chrome.exe' \
  pnpm probe:topology --https-acceptance \
  --output docs/evidence/issue-2-topology-wsl2.json
```

The probe invokes Windows Chrome only after it confirms a loopback-only listener on port 443 and successfully reaches all exact HTTPS routes through Linux without disabling certificate verification. Otherwise it records a blocker and does not invoke the browser. Temporary databases, Portless state, processes, aliases, profiles, and screenshots are cleaned up. The normal test suite covers verified ext4 and mounted-Windows SQLite behavior, full backup `integrity_check`, canonical-root/symlink containment, atomic state writes, owner-token and executable process identity, dynamic ports, route replacement, graceful stop, and post-restart loopback/LAN isolation. Committed evidence redacts user paths, IP addresses, PIDs, owner tokens, temporary paths, and full `.wslconfig` content while retaining probe/source versions, generating commit, browser version, and reproduction commands.

## Consequences and tradeoffs

- The database is not automatically portable with a Windows workspace. Export/import and tested backups provide portability instead.
- Ext4 state depends on the WSL distribution/VHD being backed up appropriately.
- Multiple application processes can share SQLite safely, but there remains one writer at a time.
- Exact stable names are independent of backend ports and Git worktree names.
- The launcher must manage Portless aliases and process identity instead of delegating child ownership to `portless run`.
- Root elevation may be needed for the normal HTTPS proxy on port 443, while application/model children remain unprivileged.
- Windows does not own or directly manipulate Linux PIDs, SQLite, model files, or runtime manifests.

## Integration blocker and unresolved environmental checks

The ADR is not accepted for integration until item 1 passes and fresh redacted evidence reports `acceptanceStatus: "pass"`.

1. Start the normal Portless HTTPS proxy interactively on port 443, run `portless trust`, restart Windows Chrome if needed, and rerun the exact HTTPS acceptance command. This worker had no non-interactive sudo credential, did not modify host trust stores, and therefore did not invoke Windows Chrome for the blocked run.
2. Repeat the probe after changes to WSL networking mode, Portless version, Windows browser, antivirus policy, or `/mnt/c` mount behavior.
3. Validate the eventual real `llama.cpp` and `llama.cpp-omni` binaries accept the assigned loopback addresses/ports and stop within the launcher grace period. No models or inference engines were downloaded in this spike.
4. Measure model RAM, swap, VRAM, and throughput under representative load. GPU visibility is proven; inference capacity is not.
5. Define and test the user's ext4/VHD backup policy before irreplaceable production review state is created.
