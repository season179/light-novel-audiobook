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
process.stdout.write('registered\n')
await new Promise((resolve) => process.once('SIGUSR1', resolve))
await registry.clearOwnEntries()
process.stdout.write('cleared\n')
