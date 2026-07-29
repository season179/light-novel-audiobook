import { FileGpuLeaseCoordinator } from '../../src/index.js'

const lockFilePath = process.argv[2]
if (!lockFilePath) process.exit(64)
const lease = await new FileGpuLeaseCoordinator({ lockFilePath }).acquire('gemma')
await lease.quarantine('runtime accelerator residency could not be disproved')
await lease.release()
process.stdout.write('quarantined\n')
