export type NativeTitleBarTheme = 'dark' | 'light';

export interface NativeTitleBarOverlayTheme {
  color: string;
  symbolColor: string;
  height: number;
}

export function getTitleBarOverlayTheme(
  theme: NativeTitleBarTheme,
): NativeTitleBarOverlayTheme {
  return theme === 'light'
    ? { color: '#f7fafd', symbolColor: '#16283c', height: 44 }
    : { color: '#0c1726', symbolColor: '#c7d3e2', height: 44 };
}
