/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Цвета живут в CSS-переменных (tokens.css) — так работает светлая тема.
      // Триплеты сохраняют поддержку прозрачности (bg-surface-light/70 и т.п.).
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--twc-surface) / <alpha-value>)',
          panel: 'rgb(var(--twc-surface-panel) / <alpha-value>)',
          light: 'rgb(var(--twc-surface-light) / <alpha-value>)',
          card: 'rgb(var(--twc-surface-card) / <alpha-value>)',
          hover: 'rgb(var(--twc-surface-hover) / <alpha-value>)',
          elevated: 'rgb(var(--twc-surface-elevated) / <alpha-value>)',
          border: 'rgb(var(--twc-surface-border) / <alpha-value>)',
          'border-strong': 'rgb(var(--twc-surface-border-strong) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--twc-accent) / <alpha-value>)',
          hover: 'rgb(var(--twc-accent-hover) / <alpha-value>)',
          soft: 'var(--accent-soft)',
          ring: 'var(--accent-ring)',
        },
        ink: {
          DEFAULT: 'rgb(var(--twc-ink) / <alpha-value>)',
          muted: 'rgb(var(--twc-ink-muted) / <alpha-value>)',
          faint: 'rgb(var(--twc-ink-faint) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'Inter Variable',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI Variable',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
      },
      borderRadius: {
        xl: '12px',
        '2xl': '16px',
        card: '16px',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(0,0,0,0.45)',
        card: '0 1px 2px rgba(0,0,0,0.38), 0 18px 44px -22px rgba(0,0,0,0.72)',
        pop: '0 34px 90px -30px rgba(0,0,0,0.82)',
        glow: '0 0 0 1px rgba(52,199,123,0.34), 0 12px 36px -12px rgba(52,199,123,0.45)',
        'panel-focus':
          '0 1px 2px rgba(0,0,0,0.4), 0 26px 74px -32px rgba(0,0,0,0.82), inset 0 1px 0 rgba(255,255,255,0.04)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.15s ease-out',
        'scale-in': 'scale-in 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
