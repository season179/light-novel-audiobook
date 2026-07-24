# Scripts

Development, model benchmarking, and operational helper scripts belong here. Production pipeline behavior belongs in the TypeScript application and domain packages rather than accumulating in ad-hoc scripts.

## Topology probe

`pnpm test:topology` runs the synthetic SQLite, path, process, dynamic-port, Portless, and loopback-isolation integration tests. `pnpm probe:topology` records host resources and repeats the checks on WSL ext4 and `/mnt/c`. Set `TOPOLOGY_WINDOWS_BROWSER` to a mounted Windows Chrome or Edge executable to include the Windows-browser reachability check. See [`docs/adr/0001-wsl2-runtime-topology.md`](../docs/adr/0001-wsl2-runtime-topology.md).
