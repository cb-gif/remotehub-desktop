import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { rebuildNativeDependencies } from './native-dependencies.mjs'

// Electron 44 downloads its runtime on first require instead of in postinstall.
// Do that once during setup, before parallel test workers or the app need it.
const require = createRequire(import.meta.url)
require('electron')
await rebuildNativeDependencies({ appDir: fileURLToPath(new URL('../', import.meta.url)) })
