---
name: NSAA Tickets
description: A tactile paper-and-coral ticketing system for Ghana's event marketplace: warm, precise, and built for trust.
colors:
  paper: "#f7f1e6"
  paper-soft: "#f0e8d8"
  paper-surface: "#ffffff"
  ink: "#241f1a"
  ink-muted: "#6b5f52"
  ink-faint: "#9c9186"
  charcoal: "#221d18"
  charcoal-soft: "#2c2620"
  on-charcoal: "#f7f1e6"
  on-charcoal-muted: "#b5a99a"
  coral: "#f44e25"
  coral-hover: "#f66946"
  coral-ink: "#241f1a"
  gold: "#d9a441"
  teal: "#279485"
  pink: "#d9578a"
  plum: "#8a5178"
  olive: "#7c8c4a"
  danger: "#c43d3d"
rounded:
  control: "4px"
  media: "4px"
  qr-shell: "8px"
typography:
  family: "Instrument Sans"
  display: "850 weight, tight line-height, max 4.2rem"
  product: "single-family sans scale, compact labels, readable forms"
---

# Design System: NSAA Tickets

## 1. North Star

**The Trusted Ticket Counter.** NSAA should feel like the clean, official counter between an event organizer and a buyer: tactile enough to belong to real Ghanaian gatherings, precise enough to trust with money and entry.

The current shipped identity is warm paper, ink charcoal, and ignite coral. The navbar uses paper chrome with ink text; charcoal is reserved for the footer, scanner surfaces, and ticket-like dark islands. Coral is the primary action color. Gold is a highlight for revenue, selling-fast, and payout moments; it is not the primary CTA.

## 2. Product Principles

- **Trust first:** itemized fees, visible reservation holds, one-time QR language, verified organizer/venue signals.
- **Mobile pressure:** common buyer actions should be one or two taps: today, weekend, city, free/paid, buy, view ticket.
- **Organizer seriousness:** distribution links, scanner staff, payout status, and referral attribution should feel operational, not decorative.
- **Local without pastiche:** no WhatsApp-flyer chaos, no generic SaaS glass. Use strong typography, real event imagery, and clear payment language.

## 3. Color Rules

- Paper (`#f7f1e6`) is the page background; white is reserved for inputs, QR shells, and high-clarity panels.
- Charcoal (`#221d18`) is footer, scanner, and selected dark ticket surfaces. The main navbar stays light paper chrome.
- Coral (`#f44e25`) is the only primary action color: buy, reserve, create, send. CTA labels on coral use ink charcoal for normal-size text contrast.
- Gold (`#d9a441`) marks value and urgency: totals, revenue, selling-fast, payout.
- Teal is success/payment-confirmed; danger red is error/void/refund.

Avoid returning to the old all-dark gold ledger direction. It made NSAA look like a crypto/SaaS template and conflicts with the current implementation.

## 4. Components

- Buttons, inputs, cards, chips: 4px radius.
- Cards/panels: flat at rest with hairline borders, no decorative blur.
- Event cards: image-led, price/availability visible, title in ink.
- Forms: labels are compact and readable; validation states must be explicit.
- Organizer signup: collect organizer/account readiness only. Event details, pricing, ticket quantities, and ticket tiers belong in the Create Event flow.
- Scanner UI: high-contrast state panels, large accepted/rejected feedback, no decorative distractions.
- Admin/organizer UI: dense, predictable, table-friendly, and action-oriented.

## 5. Motion

Use short state motion only: hover lift, status reveal, skeleton shimmer, scanner feedback. Respect reduced-motion settings.

## 6. Do / Don't

Do:
- Show fees before payment.
- Show reservation countdowns during checkout.
- Use event slugs, organizer profiles, and venue profiles as trust signals.
- Make sharing and scanner links operational.

Don't:
- Hide organizer acquisition in the footer.
- Use a shared scanner key as the primary scanner model.
- Let admin/payout/refund work live only in command-line functions.
- Mix the old black/gold design story with the current paper/coral UI.
