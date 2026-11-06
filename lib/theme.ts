export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'memoweb_theme'

export function normalizeTheme(value: string | null | undefined): Theme | null {
  return value === 'light' || value === 'dark' ? value : null
}

export function resolveTheme(stored: string | null | undefined, prefersDark: boolean): Theme {
  return normalizeTheme(stored) ?? (prefersDark ? 'dark' : 'light')
}

export function nextTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark'
}

export function themeColor(theme: Theme): string {
  return theme === 'light' ? '#f6f8fa' : '#161b22'
}
