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

const ALLOWED_STEP_KEYS = new Set(['name', 'uses', 'with', 'shell', 'run'])
const ALLOWED_STEP_KEY_ORDERS = [
  ['name', 'uses', 'with'],
  ['name', 'run'],
  ['name', 'shell', 'run'],
]

function stripInlineComment(value) {
  return value.replace(/\s+#.*$/u, '').trim()
}

function parseWithBlock(lines, start, end, stepName) {
  const entries = []
  const seen = new Set()
  let cursor = start
  for (; cursor < end; cursor += 1) {
    const line = lines[cursor]
    if (line === '' || /^\s*#/u.test(line)) continue
    if (/^ {8}[A-Za-z0-9_-]+:/u.test(line)) break
    const entryMatch = /^ {10}([A-Za-z0-9_-]+):\s*(.*?)\s*$/u.exec(line)
    if (!entryMatch) {
      throw new Error(`validate-macos step ${stepName} has malformed with content: ${line.trim()}`)
    }
    const [, key, rawValue] = entryMatch
    if (seen.has(key)) throw new Error(`validate-macos step ${stepName} duplicates with.${key}`)
    seen.add(key)
    entries.push([key, stripInlineComment(rawValue)])
  }
  if (entries.length === 0)
    throw new Error(`validate-macos step ${stepName} has an empty with block`)
  return { cursor, entries }
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

    const stepName = nameMatch[1]
    let end = index + 1
    while (end < lines.length && !/^ {6}- /u.test(lines[end])) end += 1
    const step = { name: stepName }
    const keyOrder = ['name']
    const seen = new Set(keyOrder)
    let withKeyOrder = []

    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const line = lines[cursor]
      if (line === '' || /^\s*#/u.test(line)) continue
      const keyMatch = /^ {8}([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line)
      if (!keyMatch) {
        throw new Error(`validate-macos step ${stepName} has malformed content: ${line.trim()}`)
      }
      const [, key, rawValue] = keyMatch
      if (!ALLOWED_STEP_KEYS.has(key)) {
        throw new Error(`validate-macos step ${stepName} uses unmodeled key ${key}`)
      }
      if (seen.has(key)) throw new Error(`validate-macos step ${stepName} duplicates key ${key}`)
      seen.add(key)
      keyOrder.push(key)

      if (key === 'with') {
        if (rawValue.trim() !== '') {
          throw new Error(`validate-macos step ${stepName} must use a block with mapping`)
        }
        const parsedWith = parseWithBlock(lines, cursor + 1, end, stepName)
        step.with = Object.fromEntries(parsedWith.entries)
        withKeyOrder = parsedWith.entries.map(([withKey]) => withKey)
        cursor = parsedWith.cursor - 1
        continue
      }

      if (key === 'run' && rawValue.trim() === '|') {
        const commandLines = []
        let commandIndex = cursor + 1
        for (; commandIndex < end; commandIndex += 1) {
          const commandLine = lines[commandIndex]
          if (/^ {8}[A-Za-z0-9_-]+:/u.test(commandLine)) break
          if (commandLine.startsWith('          ')) {
            commandLines.push(commandLine.slice(10))
          } else if (commandLine === '') {
            commandLines.push('')
          } else {
            throw new Error(
              `validate-macos step ${stepName} has malformed run content: ${commandLine.trim()}`,
            )
          }
        }
        while (commandLines.at(-1) === '') commandLines.pop()
        step.run = commandLines.join('\n')
        cursor = commandIndex - 1
        continue
      }

      const value = stripInlineComment(rawValue)
      if (!value) throw new Error(`validate-macos step ${stepName} has an empty ${key} value`)
      step[key] = value
    }

    if (!ALLOWED_STEP_KEY_ORDERS.some((allowed) => allowed.join('\0') === keyOrder.join('\0'))) {
      throw new Error(
        `validate-macos step ${stepName} has unapproved key order ${keyOrder.join(' -> ')}`,
      )
    }
    workflowSteps.push({ step, keyOrder, withKeyOrder })
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
  const expectedSteps = [...specification.setupSteps, ...specification.steps]
  const parsedSteps = extractWorkflowSteps(workflowText, specification.jobId)
  assert.equal(parsedSteps.length, expectedSteps.length)
  for (const [index, parsed] of parsedSteps.entries()) {
    const expected = expectedSteps[index]
    assert.deepEqual(parsed.keyOrder, Object.keys(expected))
    assert.deepEqual(parsed.withKeyOrder, expected.with ? Object.keys(expected.with) : [])
    assert.deepEqual(parsed.step, expected)
  }

  const ubuntuHash = createHash('sha256')
    .update(canonicalJobText(workflowText, 'validate'))
    .digest('hex')
  assert.equal(ubuntuHash, specification.ubuntuJobSha256)
}

const exactMacosSetupSteps = [
  {
    name: 'Check out repository',
    uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    with: { 'fetch-depth': '1' },
  },
  {
    name: 'Install pinned pnpm',
    uses: 'pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320',
    with: { run_install: 'false' },
  },
  {
    name: 'Install pinned Node.js',
    uses: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    with: { 'node-version-file': '.node-version', cache: 'pnpm' },
  },
]

const exactMacosGateSteps = [
  {
    name: 'Build and install pinned FFmpeg/ffprobe 7.0.2 from source',
    shell: 'bash',
    run: 'bash scripts/build-ffmpeg-macos.sh',
  },
  { name: 'Install dependencies', run: 'pnpm install --frozen-lockfile' },
  {
    name: 'Build and verify pinned Darwin kernel-lock helper',
    run: 'pnpm --filter @light-novel-audiobook/kernel-lock build:helper:darwin',
  },
  { name: 'Run native macOS toolchain preflight', run: 'pnpm preflight' },
  { name: 'Run formatting, linting, and import checks', run: 'pnpm exec biome check .' },
  { name: 'Typecheck workspace', run: 'pnpm typecheck' },
  {
    name: 'Run portable macOS policy tests',
    run: 'node --test scripts/test/preflight-toolchain.test.mjs scripts/test/ffmpeg-artifacts.test.mjs scripts/test/macos-ci-gate.test.mjs',
  },
  { name: 'Build workspace', run: 'pnpm build' },
  {
    name: 'Run Darwin kernel-lock, EPUB, GPU lease, and fake-pipeline tests',
    run: 'pnpm exec vitest run packages/kernel-lock/test/darwin-held-kernel-lock.test.ts packages/epub-ingestion/test/book-lock.darwin.test.ts packages/epub-ingestion/test/book-lock.unref-ordering.test.ts packages/gpu-lease/test/darwin-file-gpu-lease.test.ts packages/gemma-benchmark/test/benchmark-lock.darwin.test.ts packages/pipeline-driver/test/driver.fake-transports.test.ts',
  },
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

test('the committed gate is the exact amended issue #108/#109 command set', () => {
  assert.equal(gate.schemaVersion, 1)
  assert.equal(gate.jobId, 'validate-macos')
  assert.equal(gate.runner, 'macos-15')
  assert.deepEqual(gate.setupSteps, exactMacosSetupSteps)
  assert.deepEqual(gate.steps, exactMacosGateSteps)
  assert.equal(
    gate.steps.some(({ run }) => run === 'pnpm check'),
    false,
  )
  assert.match(gate.purpose, /not an equivalent or substitute for the Linux\/WSL2 pnpm check gate/)
  assert.deepEqual(
    gate.excludedLinuxOnlyContracts.map(({ primitive }) => primitive),
    [
      'WSL2 installer validation',
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

test('the policy rejects disabling, duplicate, reordered, and trailing step keys', () => {
  const disabled = replaceLast(
    workflow,
    '      - name: Typecheck workspace\n        run: pnpm typecheck',
    '      - name: Typecheck workspace\n        if: false\n        run: pnpm typecheck',
  )
  assert.throws(() => validateWorkflow(disabled), /unmodeled key if/)

  const ignoredFailure = replaceLast(
    workflow,
    '      - name: Typecheck workspace\n        run: pnpm typecheck',
    '      - name: Typecheck workspace\n        continue-on-error: true\n        run: pnpm typecheck',
  )
  assert.throws(() => validateWorkflow(ignoredFailure), /unmodeled key continue-on-error/)

  const duplicateRun = replaceLast(
    workflow,
    '      - name: Typecheck workspace\n        run: pnpm typecheck',
    '      - name: Typecheck workspace\n        run: pnpm typecheck\n        run: pnpm check',
  )
  assert.throws(() => validateWorkflow(duplicateRun), /duplicates key run/)

  const duplicateName = replaceLast(
    workflow,
    '      - name: Typecheck workspace\n        run: pnpm typecheck',
    '      - name: Typecheck workspace\n        name: Hidden typecheck\n        run: pnpm typecheck',
  )
  assert.throws(() => validateWorkflow(duplicateName), /duplicates key name/)

  const reorderedShellRun = replaceLast(
    workflow,
    '      - name: Build and install pinned FFmpeg/ffprobe 7.0.2 from source\n        shell: bash\n        run: bash scripts/build-ffmpeg-macos.sh',
    '      - name: Build and install pinned FFmpeg/ffprobe 7.0.2 from source\n        run: bash scripts/build-ffmpeg-macos.sh\n        shell: bash',
  )
  assert.throws(() => validateWorkflow(reorderedShellRun), /unapproved key order/)

  const trailingUnknown = replaceLast(
    workflow,
    '          [[ "$ffprobe_version" == "ffprobe version 7.0.2"* ]]',
    '          [[ "$ffprobe_version" == "ffprobe version 7.0.2"* ]]\n        timeout-minutes: 1',
  )
  assert.throws(() => validateWorkflow(trailingUnknown), /unmodeled key timeout-minutes/)
})

test('the policy pins with block values, key uniqueness, and key order', () => {
  const changedWith = replaceLast(workflow, '          fetch-depth: 1', '          fetch-depth: 0')
  assert.throws(() => validateWorkflow(changedWith))

  const duplicateWith = replaceLast(
    workflow,
    '          node-version-file: .node-version\n          cache: pnpm',
    '          node-version-file: .node-version\n          cache: pnpm\n          cache: npm',
  )
  assert.throws(() => validateWorkflow(duplicateWith), /duplicates with\.cache/)

  const reorderedWith = replaceLast(
    workflow,
    '          node-version-file: .node-version\n          cache: pnpm',
    '          cache: pnpm\n          node-version-file: .node-version',
  )
  assert.throws(() => validateWorkflow(reorderedWith))

  const withOnRunStep = replaceLast(
    workflow,
    '      - name: Typecheck workspace\n        run: pnpm typecheck',
    '      - name: Typecheck workspace\n        with:\n          bypass: true\n        run: pnpm typecheck',
  )
  assert.throws(() => validateWorkflow(withOnRunStep), /unapproved key order/)
})
