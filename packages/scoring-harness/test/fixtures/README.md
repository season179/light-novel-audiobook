# Synthetic scoring analogue

These JSON files are deterministic, project-authored synthetic data dedicated under CC0-1.0. They
contain no book text or private gold labels. The fixture deliberately includes repeated identical
text at separate references and two spans sharing one source passage. Its passing runs sit exactly
on the 95% speaker, 95% alias/coreference, 98% thought/spoken, 60-minute, 15.5-GiB VRAM, and 60-GiB
RAM boundaries. Tests mutate copies to exercise both sides of every acceptance threshold.

Regenerate with `pnpm --filter @light-novel-audiobook/scoring-harness build:fixtures`.
