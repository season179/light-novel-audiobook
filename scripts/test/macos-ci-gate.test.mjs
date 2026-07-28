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

function extractWorkflowSteps(workflowText, jobId) {
  const lines = extractJobLines(workflowText, jobId)
  const workflowSteps = []

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^ {6}- /u.test(lines[index])) continue
    const nameMatch = /^ {6}- name:\s+(.+)$/u.exec(lines[index])
    if (!nameMatch) {
      throw new Error(
        `validate-macos contains an unnamed or unsupported step: ${lines[index].trim()}`,
      )
    }

    let end = index + 1
    while (end < lines.length && !/^ {6}- /u.test(lines[end])) end += 1
    let uses = ''
    let shell = ''
    let run = ''
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const usesMatch = /^ {8}uses:\s+(\S+)/u.exec(lines[cursor])
      if (usesMatch) uses = usesMatch[1]
      const shellMatch = /^ {8}shell:\s+(\S+)/u.exec(lines[cursor])
      if (shellMatch) shell = shellMatch[1]
      const runMatch = /^ {8}run:\s*(.*)$/u.exec(lines[cursor])
      if (!runMatch) continue
      run = runMatch[1]
      if (run === '|') {
        const commandLines = []
        for (let commandIndex = cursor + 1; commandIndex < end; commandIndex += 1) {
          const commandLine = lines[commandIndex]
          if (commandLine.startsWith('          ')) {
            commandLines.push(commandLine.slice(10))
          } else if (commandLine === '') {
            commandLines.push('')
          } else {
            break
          }
        }
        while (commandLines.at(-1) === '') commandLines.pop()
        run = commandLines.join('\n')
      }
    }

    if (uses && run) throw new Error(`validate-macos step ${nameMatch[1]} mixes uses and run`)
    if (uses) {
      workflowSteps.push({ name: nameMatch[1], uses })
    } else if (run) {
      workflowSteps.push(shell ? { name: nameMatch[1], shell, run } : { name: nameMatch[1], run })
    } else {
      throw new Error(`validate-macos step ${nameMatch[1]} has neither uses nor run`)
    }
    index = end - 1
  }

  return workflowSteps
}

function replaceLast(value, search, replacement) {
  const index = value.lastIndexOf(search)
  assert.notEqual(index, -1, `mutation target not found: ${search}`)
  return `${value.slice(0, index)}${replacement}${value.slice(index + search.length)}`
}

function validateWorkflow(workflowText, specification = gate) {
  const jobText = canonicalJobText(workflowText, specification.jobId)
  assert.match(jobText, new RegExp(`^    runs-on: ${specification.runner}$`, 'mu'))
  assert.deepEqual(extractWorkflowSteps(workflowText, specification.jobId), [
    ...specification.setupSteps,
    ...specification.steps,
  ])

  const ubuntuHash = createHash('sha256')
    .update(canonicalJobText(workflowText, 'validate'))
    .digest('hex')
  assert.equal(ubuntuHash, specification.ubuntuJobSha256)
}

const exactMacosSetupSteps = [
  {
    name: 'Check out repository',
    uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  },
  {
    name: 'Install pinned pnpm',
    uses: 'pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320',
  },
  {
    name: 'Install pinned Node.js',
    uses: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  },
]

const exactIssue108Steps = [
  {
    name: 'Build and install pinned FFmpeg/ffprobe 7.0.2 from source',
    shell: 'bash',
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
    shell: 'bash',
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
  assert.deepEqual(gate.setupSteps, exactMacosSetupSteps)
  assert.deepEqual(gate.steps, exactIssue108Steps)
  assert.equal(
    gate.steps.some(({ run }) => run === 'pnpm check'),
    false,
  )
  assert.match(gate.purpose, /not an equivalent or substitute for the Linux\/WSL2 pnpm check gate/)
  assert.deepEqual(
    gate.excludedLinuxOnlyContracts.map(({ primitive }) => primitive),
    [
      'WSL2 installer validation',
      'flock',
      '/proc process identity',
      'ext4/DrvFS qualification and findmnt',
      'Bash 4 process-tree assumptions',
      'Linux process-group and reaper semantics',
      'Python prctl parent-death signalling',
    ],
  )
})

test('validate-macos matches every approved uses/run step and shell in exact order', () => {
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
  assert.throws(() => validateWorkflow(unnamed), /unnamed or unsupported step/)

  const substitute = workflow.replace('        run: pnpm typecheck', '        run: pnpm check')
  assert.throws(() => validateWorkflow(substitute))

  const missingShell = workflow.replace(
    '      - name: Build and install pinned FFmpeg/ffprobe 7.0.2 from source\n        shell: bash\n',
    '      - name: Build and install pinned FFmpeg/ffprobe 7.0.2 from source\n',
  )
  assert.throws(() => validateWorkflow(missingShell))

  const unapprovedAction = replaceLast(
    workflow,
    'uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    'uses: actions/setup-node@main',
  )
  assert.throws(() => validateWorkflow(unapprovedAction))

  const extraAction = workflow.replace(
    '      - name: Build and install pinned FFmpeg/ffprobe 7.0.2 from source',
    '      - name: Unapproved action substitute\n        uses: example/action@deadbeef\n\n      - name: Build and install pinned FFmpeg/ffprobe 7.0.2 from source',
  )
  assert.throws(() => validateWorkflow(extraAction))
})
