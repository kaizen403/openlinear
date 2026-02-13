import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#0a0a0a',
        foreground: '#ededed',
        muted: {
          DEFAULT: '#666666',
          foreground: '#a1a1a1',
        },
        border: {
          DEFAULT: '#1a1a1a',
          light: '#222222',
          hover: '#333333',
        },
        card: {
          DEFAULT: '#0f0f0f',
          foreground: '#ededed',
        },
        code: {
          DEFAULT: '#111111',
        },
        accent: {
          DEFAULT: '#3b82f6',
          foreground: '#ffffff',
        },
      },
      fontFamily: {
        sans: ['Geist', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['GeistMono', 'SF Mono', 'monospace'],
      },
      maxWidth: {
        'content': '1024px',
      },
      animation: {
        'gradient': 'gradient 8s linear infinite',
      },
      keyframes: {
        gradient: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
      },
    },
  },
  plugins: [],
}
export default config
