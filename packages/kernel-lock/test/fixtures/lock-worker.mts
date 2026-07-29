import { open, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { DarwinHeldKernelLockStrategy } from '../../src/index.js'

const [lockFilePath, artifactDirectory, markerPath, mode = 'hold'] = process.argv.slice(2)
if (!lockFilePath || !artifactDirectory) process.exit(64)
const lock = await new DarwinHeldKernelLockStrategy({ artifactDirectory }).acquire({
  lockFilePath,
  acquisition: { kind: 'bounded', waitMs: 10_000 },
  conflictExitCode: 75,
})
process.stdout.write('acquired\n')
if (mode === 'critical') {
  if (!markerPath) process.exit(64)
  let marker: Awaited<ReturnType<typeof open>> | undefined
  try {
    marker = await open(markerPath, 'wx', 0o600)
    await marker.writeFile(String(process.pid))
    await delay(40)
    process.stdout.write('exclusive\n')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') process.stdout.write('overlap\n')
    else throw error
  } finally {
    await marker?.close()
    await rm(markerPath, { force: true })
    await lock.release()
  }
} else {
  await new Promise<void>((resolve) => {
    process.stdin.resume()
    process.stdin.once('end', resolve)
    process.once('SIGTERM', resolve)
  })
  await lock.release()
}
