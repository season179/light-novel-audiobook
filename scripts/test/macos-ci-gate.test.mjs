import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const gate = JSON.parse(readFileSync(join(repositoryRoot, 'config', 'macos-ci-gate.json'), 'utf8'))
const workflow = readFileSync(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')

function extractJobLines(workflowText, jobId) {
  const lines = workflowText.split('\n')
  const start = lines.indexOf(`  ${jobId}:`)
  assert.notEqual(start, -1, `workflow job ${jobId} must exist`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/u.test(lines[index])) {
      end = index
      break
    }
  }
  return lines.slice(start, end)
}

function canonicalJobText(workflowText, jobId) {
  const lines = extractJobLines(workflowText, jobId)
  while (lines.at(-1) === '') lines.pop()
  return `${lines.join('\n')}\n`
}

function extractNamedRunSteps(workflowText, jobId) {
  const lines = extractJobLines(workflowText, jobId)
  const runSteps = []
  let currentName = ''

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const nameMatch = /^ {6}- name:\s+(.+)$/u.exec(line)
    if (nameMatch) {
      currentName = nameMatch[1]
      continue
    }
    if (/^ {6}- run:/u.test(line)) {
      throw new Error(`validate-macos contains an unnamed run step: ${line.trim()}`)
    }

    const runMatch = /^ {8}run:\s*(.*)$/u.exec(line)
    if (!runMatch) continue
    if (!currentName) throw new Error('validate-macos contains a run block without a step name')

    let run = runMatch[1]
    if (run === '|') {
      const commandLines = []
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1]
        if (nextLine.startsWith('          ')) {
          commandLines.push(nextLine.slice(10))
          index += 1
          continue
        }
        if (nextLine === '' && lines[index + 2]?.startsWith('          ')) {
          commandLines.push('')
          index += 1
          continue
        }
        break
      }
      run = commandLines.join('\n')
    }
    runSteps.push({ name: currentName, run })
  }

  return runSteps
}

function replaceLast(value, search, replacement) {
  const index = value.lastIndexOf(search)
  assert.notEqual(index, -1, `mutation target not found: ${search}`)
  return `${value.slice(0, index)}${replacement}${value.slice(index + search.length)}`
}

function validateWorkflow(workflowText, specification = gate) {
  const jobText = canonicalJobText(workflowText, specification.jobId)
  assert.match(jobText, new RegExp(`^    runs-on: ${specification.runner}$`, 'mu'))
  assert.deepEqual(extractNamedRunSteps(workflowText, specification.jobId), specification.steps)

  const ubuntuHash = createHash('sha256')
    .update(canonicalJobText(workflowText, 'validate'))
    .digest('hex')
  assert.equal(ubuntuHash, specification.ubuntuJobSha256)
}

const exactIssue108Steps = [
  {
    name: 'Build and install pinned FFmpeg/ffprobe 7.0.2 from source',
    run: 'bash scripts/build-ffmpeg-macos.sh',
  },
  { name: 'Install dependencies', run: 'pnpm install --frozen-lockfile' },
  { name: 'Run native macOS toolchain preflight', run: 'pnpm preflight' },
  { name: 'Run formatting, linting, and import checks', run: 'pnpm exec biome check .' },
  { name: 'Typecheck workspace', run: 'pnpm typecheck' },
  {
    name: 'Run portable macOS policy tests',
    run: 'node --test scripts/test/preflight-toolchain.test.mjs scripts/test/ffmpeg-artifacts.test.mjs scripts/test/macos-ci-gate.test.mjs',
  },
  { name: 'Build workspace', run: 'pnpm build' },
  {
    name: 'Probe installed FFmpeg/ffprobe 7.0.2 exactly',
    run: `install_directory="$HOME/.local/share/light-novel-audiobook/tools/ffmpeg/current"
ffmpeg_output="$("$install_directory/ffmpeg" -hide_banner -version)"
ffprobe_output="$("$install_directory/ffprobe" -hide_banner -version)"
ffmpeg_version="\${ffmpeg_output%%$'\\n'*}"
ffprobe_version="\${ffprobe_output%%$'\\n'*}"
printf '%s\\n%s\\n' "$ffmpeg_version" "$ffprobe_version"
[[ "$ffmpeg_version" == "ffmpeg version 7.0.2"* ]]
[[ "$ffprobe_version" == "ffprobe version 7.0.2"* ]]`,
  },
]

test('the committed gate is the exact amended issue #108 command set', () => {
  assert.equal(gate.schemaVersion, 1)
  assert.equal(gate.jobId, 'validate-macos')
  assert.equal(gate.runner, 'macos-15-arm64')
  assert.deepEqual(gate.steps, exactIssue108Steps)
  assert.equal(
    gate.steps.some(({ run }) => run === 'pnpm check'),
    false,
  )
  assert.match(gate.purpose, /not an equivalent or substitute for the Linux\/WSL2 pnpm check gate/)
  assert.deepEqual(
    gate.excludedLinuxOnlyContracts.map(({ primitive }) => primitive),
    [
      'WSL2 installer behavior',
      'flock',
      '/proc process identity',
      'ext4/DrvFS qualification and findmnt',
      'Bash 4 process-tree assumptions',
      'Linux process-group and reaper semantics',
      'Python prctl parent-death signalling',
    ],
  )
})

test('validate-macos matches every named gate run block in exact order', () => {
  validateWorkflow(workflow)
})

test('the policy rejects missing, reordered, extra, and unnamed command substitutes', () => {
  const missing = workflow.replace(
    '      - name: Typecheck workspace\n        run: pnpm typecheck\n\n',
    '',
  )
  assert.throws(() => validateWorkflow(missing))

  const reorderedGate = {
    ...gate,
    steps: [gate.steps[1], gate.steps[0], ...gate.steps.slice(2)],
  }
  assert.throws(() => validateWorkflow(workflow, reorderedGate))

  const extra = replaceLast(
    workflow,
    '      - name: Build workspace\n        run: pnpm build\n',
    '      - name: Build workspace\n        run: pnpm build\n\n      - name: Unnamed substitute disguised by prose\n        run: echo substitute\n',
  )
  assert.throws(() => validateWorkflow(extra))

  const unnamed = replaceLast(
    workflow,
    '      - name: Build workspace\n        run: pnpm build',
    '      - run: pnpm build',
  )
  assert.throws(() => validateWorkflow(unnamed), /unnamed run step/)

  const substitute = workflow.replace('        run: pnpm typecheck', '        run: pnpm check')
  assert.throws(() => validateWorkflow(substitute))
})
