# Design System: DS03 Operations & Dispatch Console

## 1. Visual World & Mode
- **Mode:** Operate (High density, high scanability, mission-critical clarity)
- **Aesthetic:** High-precision telemetry console. Clean, modern dark surface with restrained semantic color coding.
- **Tone:** Technical, robust, dependable, industrial.

## 2. Color Palette & Tokens
- **Backgrounds:**
  - Canvas: `#0a0e17`
  - Panel Surface: `#111827` (Tailwind `slate-900` / `gray-900`)
  - Elevated / Interactive: `#1e293b`
  - Border / Divider: `#334155` (1px clean border)
- **Typography Colors:**
  - Foreground (Primary): `#f8fafc` (High contrast ≥ 12:1)
  - Secondary: `#94a3b8` (Contrast ≥ 5.5:1)
  - Muted / Metadata: `#64748b` (Contrast ≥ 4.5:1)
- **Semantic Accents:**
  - Primary / Accent: `#2563eb` (Blue 600) / `#3b82f6` (Blue 500)
  - Success / Confirmed: `#059669` (Emerald 600) / `#10b981` (Emerald 500)
  - Driver / Transport: `#0284c7` (Sky 600) / `#0ea5e9` (Sky 500)
  - Warning / Held Funds: `#d97706` (Amber 600) / `#f59e0b` (Amber 500)
  - Destructive / Error / Rollback: `#dc2626` (Red 600) / `#ef4444` (Red 500)

## 3. Typography & Hierarchy
- **Font Stack:** System Sans-Serif (`ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`)
- **Monospace Stack:** `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
- **Scale:**
  - App Header Title: 1.125rem (18px) / font-bold / tracking-tight
  - Section Headers: 0.875rem (14px) / font-semibold / uppercase tracking-wider
  - Body & Form Text: 0.8125rem (13px) / font-normal
  - Microcopy & Badges: 0.6875rem (11px) / font-medium / uppercase tracking-wider
  - Numerals & Coordinates: `font-variant-numeric: tabular-nums`

## 4. Craft Floor Compliance (Anti-Slop Guardrails)
- Zero Unicode emojis in UI controls (replaced by clean inline SVG icons).
- Zero `animate-pulse` decorative dots in status indicators.
- Zero zero-offset colored blur halos or text-shadow glows.
- Zero nested card containers (flattened structural panels with subtle 1px dividers).
- Zero asymmetric heavy `border-left: 3px` on log entries.
- Fully accessible contrast ratios (WCAG AAA for text and controls).
- Browser surfaces customized: custom selection colors, themed scrollbars, accessible focus outlines.
