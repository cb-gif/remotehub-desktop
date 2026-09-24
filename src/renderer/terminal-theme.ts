import type { ITheme } from 'xterm'

// Night and Storm intentionally share the same ANSI 0–15 palette.
const tokyoAnsi: ITheme = {
  black: '#363b54', red: '#f7768e', green: '#73daca', yellow: '#e0af68',
  blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#787c99',
  brightBlack: '#363b54', brightRed: '#f7768e', brightGreen: '#73daca', brightYellow: '#e0af68',
  brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#acb0d0'
}

const terminalThemes: Record<'dark' | 'light' | 'tokyo-night' | 'tokyo-storm', ITheme> = {
  dark: { background: '#0b0f14', foreground: '#d7dee7', cursor: '#79b8ff', black: '#111821', red: '#ff7b86', green: '#57d6a5', yellow: '#e5bd68', blue: '#79b8ff', magenta: '#c4a7ff', cyan: '#70cfff', white: '#c8d2dc', brightBlack: '#778493', brightRed: '#ff9aa2', brightGreen: '#7be6bd', brightYellow: '#f2d68d', brightBlue: '#a1ccff', brightMagenta: '#d7c4ff', brightCyan: '#9be2ff', brightWhite: '#f4f7fa', selectionBackground: '#25476b', selectionForeground: '#ffffff', selectionInactiveBackground: '#24303d' },
  light: { background: '#ffffff', foreground: '#17202a', cursor: '#1769aa', black: '#111827', red: '#b42335', green: '#047857', yellow: '#8a5b00', blue: '#1769aa', magenta: '#6d28d9', cyan: '#036980', white: '#d6dde5', brightBlack: '#52606d', brightRed: '#d13b4b', brightGreen: '#16845f', brightYellow: '#9b6700', brightBlue: '#287ab8', brightMagenta: '#7c3aed', brightCyan: '#087f95', brightWhite: '#f4f6f8', selectionBackground: '#c7e1f5', selectionForeground: '#111827', selectionInactiveBackground: '#e0eaf2' },
  'tokyo-night': {
    ...tokyoAnsi,
    background: '#16161e', foreground: '#a9b1d6', cursor: '#c0caf5', cursorAccent: '#16161e',
    selectionBackground: '#515c7e4d', selectionInactiveBackground: '#515c7e25'
  },
  'tokyo-storm': {
    ...tokyoAnsi,
    background: '#1f2335', foreground: '#a9b1d6', cursor: '#c0caf5', cursorAccent: '#1f2335',
    selectionBackground: '#6f7bb640', selectionInactiveBackground: '#6f7bb625'
  }
}

export function terminalTheme(): ITheme {
  const selected = document.documentElement.dataset.theme
  return terminalThemes[selected === 'light' || selected === 'tokyo-night' || selected === 'tokyo-storm' ? selected : 'dark']
}
