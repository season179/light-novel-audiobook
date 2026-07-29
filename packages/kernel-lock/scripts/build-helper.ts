import { resolve } from 'node:path'
import { resolveVerifiedDarwinHelper } from '../src/helper-artifact.js'

const artifactDirectory = process.env.LIGHT_NOVEL_AUDIOBOOK_KERNEL_LOCK_DIR
const helper = await resolveVerifiedDarwinHelper({
  ...(artifactDirectory === undefined ? {} : { artifactDirectory: resolve(artifactDirectory) }),
})
process.stdout.write(`${helper.path}\n`)
