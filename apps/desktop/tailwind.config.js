/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#0a0b0f', // app background — near black
          panel: '#0f1117', // sidebar / panels
          light: '#15171e', // cards (legacy name kept for compatibility)
          card: '#15171e',
          hover: '#1b1e26',
          elevated: '#1d212b',
          border: '#23262f',
          'border-strong': '#2f333f',
        },
        accent: {
          DEFAULT: '#6366f1',
          hover: '#7c83f6',
          soft: 'rgba(99,102,241,0.14)',
          ring: 'rgba(99,102,241,0.35)',
        },
        ink: {
          DEFAULT: '#e7e9ef',
          muted: '#9aa1ad',
          faint: '#6b7280',
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
        soft: '0 1px 2px rgba(0,0,0,0.5)',
        card: '0 1px 2px rgba(0,0,0,0.4), 0 12px 32px -16px rgba(0,0,0,0.7)',
        pop: '0 28px 70px -24px rgba(0,0,0,0.8)',
        glow: '0 0 0 1px rgba(99,102,241,0.35), 0 10px 32px -10px rgba(99,102,241,0.45)',
        'panel-focus':
          '0 1px 2px rgba(0,0,0,0.4), 0 22px 60px -28px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,0.03)',
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
