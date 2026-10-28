import type { Config } from "tailwindcss"

/**
 * A colour token as a Tailwind colour. Every token variable is an sRGB
 * channel triplet generated from lib/design (see docs/design-tokens.md), so
 * opacity modifiers (`bg-brand/10`) work. Names must exist in the generated
 * block in app/globals.css; lib/design/tokens.test.ts checks every one.
 */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`

/** A solid fill in an interaction state: the colour at `--state-hover|pressed` alpha. */
const state = (name: string, which: "hover" | "pressed") => `rgb(var(--${name}) / var(--state-${which}))`

/** The translucent state layer at one of its alphas (`--state-layer-faint|hover|divider|outline`). */
const layer = (which: "faint" | "hover" | "divider" | "outline") => `rgb(var(--state-layer) / var(--state-layer-${which}))`

const config: Config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)"],
        ui: ["var(--font-ui)"],
        mono: ["var(--font-mono)"],
      },
      colors: {
        // shadcn roles (tier 3).
        background: token("background"),
        foreground: token("foreground"),
        card: {
          DEFAULT: token("card"),
          foreground: token("card-foreground"),
        },
        popover: {
          DEFAULT: token("popover"),
          foreground: token("popover-foreground"),
        },
        // Solid accent: fills that carry text (buttons, badges, checked
        // selections). `hover:bg-primary-hover active:bg-primary-pressed`.
        primary: {
          DEFAULT: token("primary"),
          foreground: token("primary-foreground"),
          hover: state("primary", "hover"),
          pressed: state("primary", "pressed"),
        },
        secondary: {
          DEFAULT: token("secondary"),
          foreground: token("secondary-foreground"),
        },
        muted: {
          DEFAULT: token("muted"),
          foreground: token("muted-foreground"),
        },
        // Menu highlight and ghost/outline hover (solid accent + white).
        accent: {
          DEFAULT: token("accent"),
          foreground: token("accent-foreground"),
        },
        // `text-/border-destructive` are text-safe; as a background,
        // `bg-destructive` is the solid (see backgroundColor below).
        destructive: {
          DEFAULT: token("destructive"),
          solid: token("destructive-solid"),
          foreground: token("destructive-foreground"),
          hover: state("destructive-solid", "hover"),
          pressed: state("destructive-solid", "pressed"),
        },
        border: token("border"),
        input: token("input"),
        ring: token("ring"),
        // Bright brand accent: indicators, accent text, selected borders, tints.
        brand: {
          DEFAULT: token("brand"),
          solid: token("brand-solid"),
        },
        // Tones (tier 2): text/icon/dot colour; tint with /10 (bg) and /30 (border).
        success: token("tone-success"),
        warning: token("tone-warning"),
        danger: token("tone-danger"),
        info: token("tone-info"),
        discovery: token("tone-discovery"),
        // Surfaces and state layers (tier 2).
        surface: {
          canvas: token("surface-canvas"),
          app: token("surface-app"),
          raised: token("surface-raised"),
          inset: token("surface-inset"),
          card: token("surface-card"),
          overlay: token("surface-overlay"),
          hover: token("surface-hover"),
          pressed: token("surface-pressed"),
        },
        // Translucent overlays that work on any surface (lib/design STATE_LAYER):
        // `bg-layer-faint` (unread row, group header), `hover:bg-layer-hover`,
        // `divide-layer-divider`, `border-layer-outline`. `bg-scrim/50` dims
        // the page under modals and drawers.
        layer: {
          faint: layer("faint"),
          hover: layer("hover"),
          divider: layer("divider"),
          outline: layer("outline"),
        },
        scrim: token("scrim"),
        // Board task status and priority (lib/design-tokens.ts).
        status: {
          todo: token("status-todo"),
          "in-progress": token("status-in-progress"),
          done: token("status-done"),
          cancelled: token("status-cancelled"),
          error: token("status-error"),
          committing: token("status-committing"),
          publishing: token("status-publishing"),
        },
        priority: {
          low: token("priority-low"),
          medium: token("priority-medium"),
          high: token("priority-high"),
          urgent: token("priority-urgent"),
        },
        // Agent-run phase tones (components/execution/tokens.ts).
        run: {
          neutral: token("run-neutral"),
          info: token("run-info"),
          active: token("run-active"),
          warning: token("run-warning"),
          success: token("run-success"),
          danger: token("run-danger"),
        },
        // Legacy linear-* names, kept so 2,000+ usages need no churn. Prefer
        // the semantic names above in new code.
        linear: {
          bg: token("linear-bg"),
          "bg-secondary": token("linear-bg-secondary"),
          "bg-tertiary": token("linear-bg-tertiary"),
          border: token("linear-border"),
          "border-hover": token("linear-border-hover"),
          text: token("linear-text"),
          "text-secondary": token("linear-text-secondary"),
          "text-tertiary": token("linear-text-tertiary"),
          // As text/border/ring: the bright brand. As a background: the solid
          // (see backgroundColor below).
          accent: token("brand"),
          "accent-hover": token("brand"),
        },
      },
      // Background-only overrides. `bg-linear-accent` and `bg-destructive` were
      // used almost only as fills behind white text (39 and 6 call sites), so
      // as backgrounds they resolve to the contrast-safe solids, while
      // `text-linear-accent` / `text-destructive` stay text-safe. Hover keeps
      // working for any picker accent: `bg-linear-accent-hover` is the solid
      // at the hover alpha.
      backgroundColor: {
        destructive: {
          DEFAULT: token("destructive-solid"),
        },
        linear: {
          accent: token("brand-solid"),
          "accent-hover": state("brand-solid", "hover"),
        },
      },
      opacity: {
        disabled: "var(--state-disabled)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(0 0 0 / 0.4), 0 1px 3px 0 rgb(0 0 0 / 0.3)",
        overlay:
          "0 10px 15px -3px rgb(0 0 0 / 0.5), 0 4px 6px -4px rgb(0 0 0 / 0.4)",
        elevation:
          "0 20px 25px -5px rgb(0 0 0 / 0.6), 0 8px 10px -6px rgb(0 0 0 / 0.5)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}

export default config
