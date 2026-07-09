---
name: NSAA Tickets
description: A precise, gold-on-black ledger for Ghana's event marketplace — authentication, not decoration.
colors:
  ledger-gold: "#dfb36c"
  ledger-gold-hover: "#edd39a"
  ink-on-gold: "#120e06"
  near-black: "#070709"
  soft-ink: "#0b0b0e"
  surface: "#101013"
  surface-raised: "#16161a"
  paper-white: "#f3f3f5"
  muted-slate: "#95989f"
  faint-slate: "#5b5e66"
  hairline-border: "rgba(255, 255, 255, 0.07)"
  hairline-border-strong: "rgba(255, 255, 255, 0.14)"
  mobile-money-teal: "#4adbb8"
  qr-blue: "#5fa5f9"
  rose: "#f07b8a"
  confirmation-green: "#81c784"
  confirmation-green-bg: "rgba(129, 199, 132, 0.1)"
  alert-red: "#f26b6b"
  alert-red-bg: "rgba(242, 107, 107, 0.1)"
  warning-bg: "rgba(223, 179, 108, 0.1)"
typography:
  display:
    fontFamily: "Instrument Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "clamp(2.3rem, 6.5vw, 4.2rem)"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Instrument Sans, sans-serif"
    fontSize: "clamp(1.65rem, 4vw, 2.4rem)"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Instrument Sans, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Instrument Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Instrument Sans, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.15em"
rounded:
  sm: "4px"
  md: "8px"
  full: "999px"
spacing:
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.ledger-gold}"
    textColor: "{colors.ink-on-gold}"
    rounded: "{rounded.sm}"
    padding: "0.65rem 1.25rem"
  button-primary-hover:
    backgroundColor: "{colors.ledger-gold-hover}"
    textColor: "{colors.ink-on-gold}"
    rounded: "{rounded.sm}"
    padding: "0.65rem 1.25rem"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.sm}"
    padding: "0.65rem 1.25rem"
  chip:
    backgroundColor: "rgba(255, 255, 255, 0.02)"
    textColor: "{colors.muted-slate}"
    rounded: "{rounded.sm}"
    padding: "0.15rem 0.55rem"
  card:
    backgroundColor: "{colors.soft-ink}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.sm}"
    padding: "1.5rem"
  input:
    backgroundColor: "rgba(255, 255, 255, 0.015)"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.sm}"
    height: "44px"
---

# Design System: NSAA Tickets

## 1. Overview

**Creative North Star: "The Night Market Ledger"**

NSAA Tickets is the record book at the door, not the party itself. The palette is near-black and gold: gold as authentication ink stamped onto a dark ledger page, not a glow effect. Every surface should read like it's telling the truth under pressure — a buyer with a 10-minute clock running, a scanner operator checking a QR code in a doorway at night. Precision reads as trust; decoration reads as risk.

This system explicitly rejects the generic dark "crypto/SaaS" template it could easily be mistaken for: pill-shaped gradient buttons, 20px+ rounded glass cards, backdrop blur stacked on every panel. Those read as decorative confidence, not earned confidence. NSAA earns confidence through sharp edges, flat surfaces, and a gold that behaves like a stamp of authenticity, not a glow.

**Key Characteristics:**
- Near-black ledger surface, gold used sparingly as the mark of legitimacy (price, CTA, active state, signed ticket)
- Flat by default; elevation appears only on the fixed navbar and on hover, never as resting ambient glow
- Sharp, consistent 4px radius across buttons, cards, chips, tiles — full-round (999px) reserved for true circular elements (dots, pulse indicators)
- Instrument Sans carries the whole system — weight and size do the differentiating work, not font-pairing
- Calm pacing: motion confirms state changes (hover, focus, countdown, scan result), it never performs

## 2. Colors

Near-black ledger page with a single gold accent; five muted tone colors exist only to label status (chips, checkout progress, scan results), never to compete with gold as the primary accent.

### Primary
- **Ledger Gold** (`#dfb36c`): The one accent. Primary CTA fill, active nav underline, focus rings, price emphasis, signed-ticket state. Used sparingly — if more than one element per view carries it, something is over-emphasized.
- **Ledger Gold — Hover** (`#edd39a`): Lightened on interaction only, never used at rest.

### Neutral
- **Near-Black** (`#070709`): Base page background.
- **Soft Ink** (`#0b0b0e`): Card and panel background, one step lighter than the page.
- **Surface** (`#101013`) / **Surface Raised** (`#16161a`): Skeleton/loading states and stacked-surface moments (e.g. dropdown over card).
- **Paper White** (`#f3f3f5`): Primary text. Verify ≥4.5:1 against whichever of the neutrals it sits on.
- **Muted Slate** (`#95989f`): Secondary text (meta, captions, nav links at rest). Check contrast on Near-Black before reusing on lighter surfaces.
- **Faint Slate** (`#5b5e66`): Tertiary/disabled text and footer copy only — never body copy a user must read to complete checkout.
- **Hairline Border** (`rgba(255,255,255,0.07)`) / **Hairline Border — Strong** (`rgba(255,255,255,0.14)`): The only border treatment. No colored borders except state (below).

### Tertiary — Status & Category Tone
- **Mobile Money Teal** (`#4adbb8`): "Mobile Money ready" tag and payment-method labeling only.
- **QR Blue** (`#5fa5f9`): "QR entry" tag and ticket/QR-adjacent labeling only.
- **Rose** (`#f07b8a`): Reserved tone slot for category/chip variety; not currently tied to a status meaning.
- **Confirmation Green** (`#81c784`) / bg tint (`rgba(129,199,132,0.1)`): Success status only (payment confirmed, valid ticket, order timeline "done" step).
- **Alert Red** (`#f26b6b`) / bg tint (`rgba(242,107,107,0.1)`): Failure/error status only (payment failed, ticket void/used, invalid form field).

### Named Rules
**The One Mark Rule.** Gold appears once per view as the primary point of emphasis — a CTA, a price, an active state. It is never used as a gradient, a glow, or a background fill for large surfaces; it behaves like a stamp, not a light source.

**The Earned Contrast Rule.** Muted Slate body text must hit ≥4.5:1 against whatever surface it sits on. If a design calls for it lighter "for elegance," that's the tell to stop and use Paper White instead.

## 3. Typography

**Display/Body Font:** Instrument Sans (variable, weights 300–900), with `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` fallback.

**Character:** One family carrying the entire system through weight and scale, not pairing. Heavy weights (800–850) read as confident and stamped at display size; regular weight carries calm, legible body copy. Nothing is italic; nothing is script.

### Hierarchy
- **Display** (800, `clamp(2.3rem, 6.5vw, 4.2rem)`, line-height 0.95, letter-spacing -0.04em): Page-level H1 only (home hero, event title).
- **Headline** (800, `clamp(1.65rem, 4vw, 2.4rem)`, line-height 1.05, letter-spacing -0.03em): Section titles.
- **Title** (700, 1.15rem, line-height 1.3, letter-spacing -0.01em): Card/component headings (event card title, panel heading).
- **Body** (400, 1rem, line-height 1.5): Default copy. Cap prose at 65–75ch.
- **Label** (600, 0.72rem, letter-spacing 0.15em, uppercase): Eyebrows and small tags. See Named Rule below — this is the system's most overused element and needs discipline.

### Named Rules
**The Single Eyebrow Rule.** The tracked-uppercase Label treatment is a hero-only device (one per page, above the H1). It does not repeat above every section — that reads as AI-template scaffolding, not editorial structure. If a section needs a kicker, use Title weight instead.

## 4. Elevation

Flat by default. NSAA is a ledger page, not a stack of glowing cards — surfaces sit directly on Near-Black with a 1px hairline border for separation, not a drop shadow. The two legitimate exceptions are the sticky navbar (fixed chrome over scrolling content, genuinely needs to separate) and hover states (a small lift confirms interactivity, then settles back to flat).

### Shadow Vocabulary
- **Chrome shadow** (`box-shadow: 0 10px 35px rgba(0,0,0,0.25)`): Sticky navbar only.
- **Hover lift** (`box-shadow: 0 12px 32px rgba(0,0,0,0.4)`, paired with `translateY(-2px)`): Interactive cards/tiles on hover only — never at rest.
- **Focus ring** (`box-shadow: 0 0 0 3px rgba(223,179,108,0.08–0.12)`): Inputs and search shell on focus-within.

### Named Rules
**The Flat-At-Rest Rule.** No card, panel, tile, or button carries a resting box-shadow. If an element needs to feel important at rest, that's a border-color or weight decision, not a shadow decision.

**The No-Ghost-Card Rule.** Never pair a 1px border with a ≥16px-blur shadow on the same element — that combination is the generic AI dark-SaaS "ghost card" tell this system is explicitly avoiding.

## 5. Components

### Buttons
- **Shape:** 4px radius, solid fill — not a pill.
- **Primary:** Ledger Gold background, Ink-on-Gold (`#120e06`) text, weight 700, padding `0.65rem 1.25rem`. Flat fill, no gradient.
- **Hover / Focus:** Background shifts to Ledger Gold — Hover, `translateY(-1px)`. No shadow growth.
- **Outline/Ghost:** Transparent background, Hairline Border, Paper White text; hover adds a faint white tint (`rgba(255,255,255,0.03)`) and border strengthens to Hairline Border — Strong.

### Chips
- **Style:** 4px radius, uppercase Label typography, `0.15rem 0.55rem` padding, min-height 24px.
- **Default tone:** faint white background (`rgba(255,255,255,0.02)`) + Hairline Border + Muted Slate text.
- **Status tones (`data-tone`):** teal / rose / blue / green variants use a 4%-alpha tint of the tone color as background, 20%-alpha border, full-strength text — same recipe across all four, never a solid fill.

### Cards / Containers (panels, event cards, category tiles, meta items)
- **Corner Style:** 4px radius, consistently — do not scale radius up with card size.
- **Background:** Soft Ink (`#0b0b0e`), or a faint white tint (`rgba(255,255,255,0.015–0.02)`) for nested meta items.
- **Shadow Strategy:** None at rest (see Elevation). Hover-lift only where the card is a clickable destination (event card, category tile).
- **Border:** Hairline Border at rest; shifts to Ledger Gold at 30–35% alpha on hover to signal interactivity without a shadow.
- **Internal Padding:** 1.5rem (panel), 1rem–1.25rem (tile/meta item).

### Inputs / Fields
- **Style:** Hairline Border, 4px radius, 44px min-height, near-transparent white background (`rgba(255,255,255,0.015)`).
- **Focus:** Border shifts to Ledger Gold, paired with the small Focus Ring shadow — no border-width change.
- **Error / Valid:** Border color swaps to Alert Red / Confirmation Green respectively, focus ring recolors to match.

### Navigation
- Sticky navbar, translucent Near-Black (`rgba(7,7,9,0.72)`) with backdrop blur — the one place blur is legitimate. Nav links use Muted Slate at rest, Paper White on hover/active, with a 1px Ledger Gold underline marking the active route.

### Status & Timeline (checkout, order status, door scanner)
- **Status box** (waiting/success/failed): 8px radius, tone-tinted background + border + text using the same status colors as chips (Confirmation Green / Alert Red / Ledger Gold-as-warning).
- **Order timeline:** circular dots (999px — the sanctioned full-round use), Hairline Border — Strong at rest, filled Ledger Gold when the step is active/complete.
- **QR ticket shell:** white background, 8px radius — the one deliberately "printed object" surface in an otherwise dark system, because a scannable code needs maximum contrast, not brand consistency.

## 6. Do's and Don'ts

### Do:
- **Do** keep every card, tile, button, and chip at a consistent 4px radius; reserve full-round (999px) strictly for circular elements (timeline dots, pulse indicators).
- **Do** use Ledger Gold as a flat fill only — no gradients, no glow.
- **Do** let hover states carry emphasis via a border-color shift to gold plus a 1–2px lift, not via a growing shadow.
- **Do** confine backdrop-filter blur to the sticky navbar.
- **Do** verify Muted Slate and Faint Slate against their actual background before shipping — bump to Paper White if contrast is close.
- **Do** treat the tracked-uppercase Label/eyebrow as a hero-only device, once per page.

### Don't:
- **Don't** pair a 1px border with a ≥16px-blur box-shadow on the same element (the current `.nsaa-card` / `.nsaa-panel` / `.nsaa-event-card` treatment) — this is the generic dark "crypto/SaaS" glassmorphism look PRODUCT.md explicitly rejects.
- **Don't** round cards, tiles, or buttons past 4px (current CSS has drifted to 20–22px cards/tiles and 999px pill buttons — this reads as the over-rounded AI-generic look, not the intended ledger precision).
- **Don't** apply a gold gradient fill (`linear-gradient(135deg, gold, #f3d79b)`) to buttons — use the flat Ledger Gold token.
- **Don't** stack a tracked-uppercase eyebrow above every section (current `.nsaa-eyebrow` usage on both the hero and trust cards) — reserve it for the hero only.
- **Don't** look like Eventbrite or a generic ticketing SaaS template, and don't look like the informal WhatsApp-flyer resale culture this product is positioned against.
