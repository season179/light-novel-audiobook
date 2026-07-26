import { access } from 'node:fs/promises'

const [moduleUrl, barrierPath, registryPath] = process.argv.slice(2)
if (moduleUrl === undefined || barrierPath === undefined || registryPath === undefined) {
  throw new Error('writer arguments required')
}
const { FixtureHolderRegistry } = await import(moduleUrl)
const registry = new FixtureHolderRegistry({ registryPath })

while (true) {
  try {
    await access(barrierPath)
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

await registry.registerHolder(process.pid, `/tmp/gpu-lease-registry-writer-${process.pid}`)

// The listener is installed BEFORE 'registered' is announced: the parent signals only after
// seeing the announcement, so SIGUSR1 can never arrive at a process that has no handler for it.
// A Node process without a SIGUSR1 handler starts the inspector instead of terminating, which
// stranded this wait forever when a starved writer was preempted between the announcement and
// the handler installation (#90).
const SIGUSR1_WAIT_MS = 30_000
const signalled = new Promise((resolve) => {
  process.once('SIGUSR1', resolve)
})
process.stdout.write('registered\n')
const waitDeadline = setTimeout(() => {
  process.stderr.write(
    `registry-writer ${process.pid} waited ${SIGUSR1_WAIT_MS} ms for SIGUSR1 after registering\n`,
  )
  process.exit(2)
}, SIGUSR1_WAIT_MS)
await signalled
clearTimeout(waitDeadline)

await registry.clearOwnEntries()
process.stdout.write('cleared\n')
