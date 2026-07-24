# Scripts

Development, model benchmarking, and operational helper scripts belong here. Production pipeline behavior belongs in the TypeScript application and domain packages rather than accumulating in ad-hoc scripts.

## Topology probe

`pnpm test:topology` runs the synthetic SQLite, canonical-root/symlink, process-identity, fixed-port collision/restart, atomic-manifest, and loopback/LAN-isolation integration tests. `pnpm probe:topology` records redacted host evidence and repeats SQLite checks only after verifying WSL ext4 and an explicit mounted-Windows DrvFS/9p root.

The configured host probe binds the review, brain, and TTS fixtures to `127.0.0.1` ports 3000, 8080, and 8081. Set `TOPOLOGY_WINDOWS_BROWSER` to mounted Windows Chrome to test `http://localhost:3000` directly without a shell wrapper. The same explicit host run invokes Windows `ipconfig.exe` and `curl.exe` directly, requires localhost success, and requires every reported non-loopback Windows IPv4 address to fail. A default run without host proof exits nonzero. `--skip-network` is only a successful CI synthetic mode and is labeled non-acceptance. See [`docs/adr/0001-wsl2-runtime-topology.md`](../docs/adr/0001-wsl2-runtime-topology.md).
