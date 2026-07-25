import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PYTHON_DIRECTORY = join(PACKAGE_ROOT, 'python')

/**
 * Arms the real worker's parent-death binding and then idles, standing in for a worker that is
 * still CUDA-resident inside `generate_custom_voice`.
 */
const WORKER = `
import sys, time
sys.path.insert(0, sys.argv[1])
import qwen_batch_worker
qwen_batch_worker.bind_to_parent_lifetime()
print('armed', flush=True)
time.sleep(120)
`

/** Stands in for the Node orchestrator that holds the GPU lease and spawns the worker detached. */
const ORCHESTRATOR = `
import subprocess, sys, time
worker = subprocess.Popen([sys.executable, '-c', sys.argv[2], sys.argv[1]], start_new_session=True)
print(worker.pid, flush=True)
time.sleep(120)
`

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('pinned Qwen worker parent lifetime', () => {
  it('dies with a SIGKILLed orchestrator instead of holding the GPU past the lease', async () => {
    const orchestrator = spawn('python3', ['-c', ORCHESTRATOR, PYTHON_DIRECTORY, WORKER], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    orchestrator.stdout.setEncoding('utf8')
    orchestrator.stderr.setEncoding('utf8')
    orchestrator.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    orchestrator.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    let workerPid: number | undefined
    const deadline = 10_000
    for (let waited = 0; waited < deadline; waited += 50) {
      const [first] = stdout.split('\n')
      if (first !== undefined && /^[0-9]+$/.test(first)) workerPid = Number(first)
      if (workerPid !== undefined && stdout.includes('armed')) break
      if (orchestrator.exitCode !== null) break
      await delay(50)
    }
    try {
      // The worker must have armed the binding and still be running: a worker that simply crashed
      // would satisfy the death assertion below for the wrong reason.
      expect(stderr, 'worker failed to arm parent-death signalling').toBe('')
      expect(stdout).toContain('armed')
      expect(workerPid).toBeTypeOf('number')
      expect(alive(workerPid as number)).toBe(true)

      orchestrator.kill('SIGKILL')

      let died = false
      for (let waited = 0; waited < deadline; waited += 50) {
        if (!alive(workerPid as number)) {
          died = true
          break
        }
        await delay(50)
      }
      expect(died, 'worker outlived its SIGKILLed parent').toBe(true)
    } finally {
      orchestrator.kill('SIGKILL')
      if (workerPid !== undefined && alive(workerPid)) {
        try {
          process.kill(workerPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
  })
})
