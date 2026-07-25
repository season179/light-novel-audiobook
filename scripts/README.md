# Scripts

Development, model benchmarking, and operational helper scripts belong here. Production pipeline behavior belongs in the TypeScript application and domain packages rather than accumulating in ad-hoc scripts.

## Topology probe

`pnpm test:topology` runs the synthetic SQLite, canonical-root/symlink, process-identity, fixed-port collision/restart, atomic-manifest, and loopback/LAN-isolation integration tests. `pnpm probe:topology` records redacted host evidence and repeats SQLite checks only after verifying WSL ext4 and an explicit mounted-Windows DrvFS/9p root.

The configured host probe binds the review, brain, and TTS fixtures to `127.0.0.1` ports 3000, 8080, and 8081. Set `TOPOLOGY_WINDOWS_BROWSER` to mounted Windows Chrome to test `http://localhost:3000` directly without a shell wrapper. The same explicit host run invokes Windows `ipconfig.exe` and `curl.exe` directly, requires localhost success for every configured service, and requires every configured service port to fail through every reported non-loopback Windows IPv4 address and routable non-loopback IPv6 address. The redacted evidence records the complete service/address-family attempt matrix; unavailable IPv6 is labeled explicitly. A default run without host proof exits nonzero. `--skip-network` is only a successful CI synthetic mode and is labeled non-acceptance. See [`docs/adr/0001-wsl2-runtime-topology.md`](../docs/adr/0001-wsl2-runtime-topology.md).

## VoxCPM2 runtime spike

`pnpm voxcpm2:verify` checks the pinned llama.cpp-omni and VoxCPM2 revisions, licenses,
provenance, sizes, and SHA-256 values without downloading weights. `pnpm voxcpm2:setup` creates
the isolated ext4 checkout/build/model trees and builds the two CUDA targets. `pnpm
voxcpm2:probe` runs the CLI, persistent loopback server, synthetic API characterization, resource
measurements, and destructive streaming-crash check. Raw logs, weights, source, builds, and audio
stay outside Git. See [`docs/spikes/voxcpm2-runtime.md`](../docs/spikes/voxcpm2-runtime.md).

## Synthetic voice bootstrap spike

`pnpm voices:verify` checks pinned eSpeak NG GPL/source/voice provenance. `pnpm voices:setup`
builds eSpeak NG 1.52.0 from source outside Git with MBROLA disabled. `pnpm voices:probe` creates
three deterministic formant references, reuses each across serialized non-streaming VoxCPM2
lines, and emits create-new external manifests plus sanitized evidence. Normal setup and CI run
only portable tests and never build eSpeak, start VoxCPM2, or create audio. See
[`docs/spikes/synthetic-voice-bootstrap.md`](../docs/spikes/synthetic-voice-bootstrap.md).
