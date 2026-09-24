import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminalTheme } from '../src/renderer/terminal-theme'

afterEach(() => vi.unstubAllGlobals())

describe('Tokyo Night theme', () => {
  it('uses the original Tokyo Night ANSI 16-color palette', () => {
    vi.stubGlobal('document', { documentElement: { dataset: { theme: 'tokyo-night' } } })
    expect(terminalTheme()).toMatchObject({
      black: '#363b54', red: '#f7768e', green: '#73daca', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#787c99',
      brightBlack: '#363b54', brightRed: '#f7768e', brightGreen: '#73daca', brightYellow: '#e0af68',
      brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#acb0d0'
    })
  })

  it('defines UI hierarchy, status, and component tokens', () => {
    const css = readFileSync(resolve('src/renderer/styles/tokyo-night.css'), 'utf8')
    expect(css).toContain(":root[data-theme='tokyo-night']")
    for (const token of ['--ui-canvas', '--ui-panel', '--ui-raised', '--status-connected', '--status-error', '--component-tab-indicator', '--component-terminal']) {
      expect(css).toContain(token)
    }
    expect(css).toContain('box-shadow: inset 0 -2px var(--component-tab-indicator)')
  })
})
