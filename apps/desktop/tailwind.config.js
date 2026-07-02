/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#07101d',
          panel: '#0b1422',
          light: '#101c2d',
          card: '#111f31',
          hover: '#17283d',
          elevated: '#1a2c44',
          border: '#24364f',
          'border-strong': '#34506f',
        },
        accent: {
          DEFAULT: '#34c77b',
          hover: '#58dc96',
          soft: 'rgba(52,199,123,0.15)',
          ring: 'rgba(52,199,123,0.34)',
        },
        ink: {
          DEFAULT: '#edf6ff',
          muted: '#a9b8cb',
          faint: '#73849b',
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
