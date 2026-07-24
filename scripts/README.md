# Scripts

Development, model benchmarking, and operational helper scripts belong here. Production pipeline behavior belongs in the TypeScript application and domain packages rather than accumulating in ad-hoc scripts.

## Topology probe

`pnpm test:topology` runs the synthetic SQLite, canonical-root/symlink, process-identity, dynamic-port, Portless, and post-restart loopback-isolation integration tests. `pnpm probe:topology` records redacted host evidence and repeats SQLite checks only after verifying WSL ext4 and an explicit mounted-Windows DrvFS/9p root. To attempt the configured port-443 and trust check, pass `--https-acceptance` and set `TOPOLOGY_WINDOWS_BROWSER` to mounted Windows Chrome. Chrome is never invoked by the synthetic harness or before HTTPS preconditions pass. See [`docs/adr/0001-wsl2-runtime-topology.md`](../docs/adr/0001-wsl2-runtime-topology.md).
