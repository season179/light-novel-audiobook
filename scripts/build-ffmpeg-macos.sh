#!/usr/bin/env bash
# Builds FFmpeg/ffprobe 7.0.2 for macOS arm64 from the pinned upstream source tarball tracked in
# config/ffmpeg-artifacts.json, installs the two binaries beside the Linux layout that
# packages/audio-assembly/src/ffmpeg-toolchain.ts resolves by default, and writes a sidecar
# manifest recording the exact toolchain and binary sha256 values.
#
# This script is deliberately bash 3.2-compatible so it runs under /bin/bash on stock macOS as
# well as the Homebrew bash used by GitHub's macos-*-arm64 runners.
set -euo pipefail

ffmpeg_error() {
  printf 'error: %s\n' "$1" >&2
}

ffmpeg_resolve_repository_root() {
  (
    cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
  )
}

# Prints one tab-separated line: <url>\t<archiveSha256>\t<version>. Reads the committed manifest
# so there is a single source of truth for the pinned source.
ffmpeg_read_source_pin() {
  local repository_root="$1"
  REPO_ROOT="$repository_root" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    const root = process.env.REPO_ROOT;
    const manifest = JSON.parse(readFileSync(join(root, "config", "ffmpeg-artifacts.json"), "utf8"));
    const build = manifest.builds["darwin-arm64"];
    process.stdout.write(`${build.source.url}\t${build.source.archiveSha256}\t${manifest.version}\n`);
  '
}

ffmpeg_configure_source() {
  local source_dir="$1"
  local repository_root="$2"
  local flags_file flag
  local -a configure_flags=()

  flags_file="$(mktemp -t light-novel-ffmpeg-flags)"
  if ! node "$repository_root/scripts/ffmpeg-build-manifest.mjs" flags \
    "$repository_root/config/ffmpeg-artifacts.json" > "$flags_file"; then
    rm -f "$flags_file"
    ffmpeg_error 'could not load valid darwin-arm64 configureFlags from config/ffmpeg-artifacts.json.'
    return 1
  fi

  while IFS= read -r flag; do
    configure_flags[${#configure_flags[@]}]="$flag"
  done < "$flags_file"
  rm -f "$flags_file"

  if [[ ${#configure_flags[@]} -eq 0 ]]; then
    ffmpeg_error 'darwin-arm64 configureFlags resolved to an empty array; refusing to configure.'
    return 1
  fi

  (
    cd "$source_dir"
    ./configure "${configure_flags[@]}"
  )
}

ffmpeg_cleanup() {
  if [[ -n "${FFMPEG_CLEANUP_INSTALL_PREFIX:-}" ]]; then
    rm -f "$FFMPEG_CLEANUP_INSTALL_PREFIX/ffmpeg.new" \
      "$FFMPEG_CLEANUP_INSTALL_PREFIX/ffprobe.new" \
      "$FFMPEG_CLEANUP_INSTALL_PREFIX/.ffmpeg-build-manifest.json.new"
  fi
  if [[ -n "${FFMPEG_CLEANUP_WORK_DIR:-}" ]]; then
    rm -rf "$FFMPEG_CLEANUP_WORK_DIR"
  fi
}

ffmpeg_record_toolchain() {
  local macos_version xcode_version clang_version sdk_path sdk_version make_version
  macos_version="$(sw_vers -productVersion 2>/dev/null || echo unknown)"
  xcode_version="$(xcodebuild -version 2>/dev/null | head -n 1 || echo unknown)"
  clang_version="$(clang --version 2>/dev/null | head -n 1 || echo unknown)"
  sdk_path="$(xcrun --show-sdk-path 2>/dev/null || echo unknown)"
  sdk_version="$(xcrun --show-sdk-version 2>/dev/null || echo unknown)"
  make_version="$(make --version 2>/dev/null | head -n 1 || echo unknown)"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$macos_version" "$xcode_version" "$clang_version" "$sdk_path" "$sdk_version" "$make_version" \
    "$(uname -m)"
}

ffmpeg_main() {
  local repository_root install_prefix source_url source_sha version
  repository_root="$(ffmpeg_resolve_repository_root)"
  install_prefix="${LIGHT_NOVEL_AUDIOBOOK_FFMPEG_DIR:-$HOME/.local/share/light-novel-audiobook/tools/ffmpeg/current}"

  if [[ "$(uname -s)" != 'Darwin' ]]; then
    ffmpeg_error 'this builder must run on macOS; use the Ubuntu lane for the Linux static archive.'
    return 1
  fi
  if [[ "$(uname -m)" != 'arm64' ]]; then
    ffmpeg_error "this builder targets Apple Silicon arm64; detected $(uname -m)."
    return 1
  fi

  local required_command
  for required_command in curl clang make shasum tar xcrun; do
    if ! command -v "$required_command" >/dev/null 2>&1; then
      ffmpeg_error "required macOS command is missing: $required_command"
      return 1
    fi
  done

  IFS=$'\t' read -r source_url source_sha version < <(ffmpeg_read_source_pin "$repository_root")
  if [[ -z "$source_url" || -z "$source_sha" || -z "$version" ]]; then
    ffmpeg_error 'could not read the darwin-arm64 source pin from config/ffmpeg-artifacts.json.'
    return 1
  fi

  printf 'Building FFmpeg %s for darwin/arm64\n' "$version"
  printf '  source:   %s\n' "$source_url"
  printf '  archive:  %s\n' "$source_sha"
  printf '  install:  %s\n' "$install_prefix"

  local work_dir archive download
  work_dir="$(mktemp -d -t light-novel-ffmpeg)"
  FFMPEG_CLEANUP_WORK_DIR="$work_dir"
  FFMPEG_CLEANUP_INSTALL_PREFIX="$install_prefix"
  trap ffmpeg_cleanup EXIT
  archive="$work_dir/ffmpeg-${version}.tar.xz"
  download="$archive.download"

  printf 'Downloading source tarball...\n'
  curl --fail --location --retry 3 --retry-all-errors --proto '=https' --tlsv1.2 \
    "$source_url" --output "$download"
  mv "$download" "$archive"

  printf 'Verifying archive sha256...\n'
  local actual_sha
  actual_sha="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
  if [[ "$actual_sha" != "$source_sha" ]]; then
    ffmpeg_error "archive sha256 mismatch: expected $source_sha, got $actual_sha"
    return 1
  fi

  printf 'Extracting...\n'
  tar -xJf "$archive" -C "$work_dir"
  local source_dir="$work_dir/ffmpeg-${version}"
  if [[ ! -d "$source_dir" ]]; then
    ffmpeg_error "expected source directory was not created: $source_dir"
    return 1
  fi

  local jobs
  jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"

  printf 'Configuring (make -j%s)...\n' "$jobs"
  # No --prefix: the binaries are copied out of the build tree directly so they land beside the
  # Linux layout (ffmpeg/ffprobe at the install root, not under bin/). The ordered configure flags
  # come only from config/ffmpeg-artifacts.json and are validated before this call.
  ffmpeg_configure_source "$source_dir" "$repository_root"

  printf 'Compiling...\n'
  make -C "$source_dir" -j"$jobs"

  local built_ffmpeg="$source_dir/ffmpeg"
  local built_ffprobe="$source_dir/ffprobe"
  if [[ ! -x "$built_ffmpeg" || ! -x "$built_ffprobe" ]]; then
    ffmpeg_error 'the build did not produce executable ffmpeg and ffprobe binaries.'
    return 1
  fi

  local ffmpeg_version_line ffprobe_version_line
  ffmpeg_version_line="$("$built_ffmpeg" -hide_banner -version | head -n 1)"
  ffprobe_version_line="$("$built_ffprobe" -hide_banner -version | head -n 1)"
  printf '  %s\n' "$ffmpeg_version_line"
  printf '  %s\n' "$ffprobe_version_line"
  if [[ "$ffmpeg_version_line" != "ffmpeg version ${version}"* ]]; then
    ffmpeg_error "ffmpeg reported an unexpected version: $ffmpeg_version_line"
    return 1
  fi
  if [[ "$ffprobe_version_line" != "ffprobe version ${version}"* ]]; then
    ffmpeg_error "ffprobe reported an unexpected version: $ffprobe_version_line"
    return 1
  fi

  mkdir -p "$install_prefix"
  # Stage each file beside its destination and clean staged files on failure. The three renames
  # are individually atomic, but this does not claim set-level crash atomicity for the pair and
  # sidecar.
  cp -f "$built_ffmpeg" "$install_prefix/ffmpeg.new"
  cp -f "$built_ffprobe" "$install_prefix/ffprobe.new"
  chmod 0755 "$install_prefix/ffmpeg.new" "$install_prefix/ffprobe.new"

  local ffmpeg_sha ffprobe_sha
  ffmpeg_sha="$(shasum -a 256 "$install_prefix/ffmpeg.new" | cut -d ' ' -f 1)"
  ffprobe_sha="$(shasum -a 256 "$install_prefix/ffprobe.new" | cut -d ' ' -f 1)"

  local toolchain_fields
  toolchain_fields="$(ffmpeg_record_toolchain)"
  local macos_version xcode_version clang_version sdk_path sdk_version make_version uname_m
  IFS=$'\t' read -r macos_version xcode_version clang_version sdk_path sdk_version make_version uname_m \
    <<< "$toolchain_fields"

  local sidecar="$install_prefix/.ffmpeg-build-manifest.json"
  node "$repository_root/scripts/ffmpeg-build-manifest.mjs" write-sidecar \
    "$repository_root/config/ffmpeg-artifacts.json" \
    "$sidecar.new" \
    "$version" \
    "darwin/$uname_m" \
    "$source_url" \
    "$source_sha" \
    "$macos_version" \
    "$xcode_version" \
    "$clang_version" \
    "$sdk_path" \
    "$sdk_version" \
    "$make_version" \
    "$install_prefix/ffmpeg" \
    "$ffmpeg_sha" \
    "$install_prefix/ffprobe" \
    "$ffprobe_sha"
  node "$repository_root/scripts/ffmpeg-build-manifest.mjs" verify-sidecar \
    "$repository_root/config/ffmpeg-artifacts.json" "$sidecar.new"

  mv -f "$install_prefix/ffmpeg.new" "$install_prefix/ffmpeg"
  mv -f "$install_prefix/ffprobe.new" "$install_prefix/ffprobe"
  mv -f "$sidecar.new" "$sidecar"

  printf '\nBuilt and installed FFmpeg %s:\n' "$version"
  printf '  ffmpeg:  %s\n' "$install_prefix/ffmpeg"
  printf '    sha256: %s\n' "$ffmpeg_sha"
  printf '  ffprobe: %s\n' "$install_prefix/ffprobe"
  printf '    sha256: %s\n' "$ffprobe_sha"
  printf '  manifest: %s\n' "$install_prefix/.ffmpeg-build-manifest.json"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  ffmpeg_main "$@"
fi
