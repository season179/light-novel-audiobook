import { createDirectionScriptSha256 } from '../src/index.js'
import { createDirectionFixtureBook } from './support/direction-fixture.js'

process.stdout.write(createDirectionScriptSha256(createDirectionFixtureBook()))
