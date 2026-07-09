# Nsaa Tickets

Guest-first, fee-transparent, fraud-resistant ticketing for concerts,
nightlife, conferences, sports, weddings, comedy, theatre, religious
events, workshops, and more in Ghana. Built with HTML/CSS/Bootstrap/vanilla JS,
Clerk, Convex, Brevo, and Moolre.

## What's real in this scaffold

- **Convex schema** (`convex/schema.ts`) - events, ticket types, orders,
  tickets. Tickets are non-transferable and non-resellable by design.
- **Reservation-with-timeout checkout** (`convex/orders.ts`) - inventory
  is held the instant checkout starts, released automatically after 10
  minutes if unpaid, via both a precise scheduled function and a 5-minute
  safety-net cron.
- **Signed, one-time-use QR tickets** (`convex/tickets.ts`) - HMAC-signed
  tokens, atomic scan-and-void via Convex mutations so a screenshotted
  code cannot be used twice.
- **Moolre webhook handling** (`convex/moolre.ts`, `convex/http.ts`) -
  idempotent payment confirmation, ticket issuance, SMS + email
  notification.
- **Full frontend flow** (`public/*.html`) - event discovery, category
  browsing, search, event detail, guest checkout with itemized fee
  breakdown, order status, ticket wallet with real QR rendering, door
  scanner using the device camera, organizer inquiry, about, and 404.
- **Organizer self-serve dashboard** (`public/organizer-dashboard.html`,
  the `events:createEvent`/`updateEvent`/`setEventStatus`/
  `createTicketType`/`updateTicketType`/`deleteTicketType` mutations and
  `events:eventsForCurrentOrganizer`/`salesSummaryForEvent` queries in
  `convex/events.ts`) - any signed-in Clerk user can create, edit,
  publish/unpublish their own events, manage ticket types, and see a
  per-event sales summary. Ownership is stored as `organizerClerkUserId`
  on `events` and always derived server-side from the verified identity,
  never a client-supplied id. `seedDemoEvent` is unrelated/still
  available for local demo data (seeded events have no organizer owner).

## What you MUST fill in before this runs for real

1. **Convex deployment**

   ```
   npm install
   npx convex dev
   ```

   This gives you a deployment URL (`https://xxxx.convex.cloud`). Replace
   `https://REPLACE_ME.convex.cloud` in `public/js/nsaa.js` with it.

2. **Seed a demo event** - once `convex dev` is running, open the Convex
   dashboard's function runner and call `events:seedDemoEvent` once.

3. **Clerk** - create an app at clerk.com, get your Frontend API URL and
   publishable key, fill into `.env.local` and `convex/auth.config.ts`.
   Note: checkout is guest-first by design. If a buyer is already signed
   in, the reservation is linked to their Clerk identity for the wallet.
   A post-purchase account-claim prompt is still a product follow-up.

4. **Moolre** - get sandbox API credentials, set them via
   `npx convex env set MOOLRE_API_KEY ...` (see `.env.example` for the
   full list). **Confirm the actual request/response field names against
   Moolre's current API docs** - `convex/orders.ts` and `convex/moolre.ts`
   are written against a generic REST payment-collection shape and will
   need field-name adjustments once you're looking at their real
   reference docs.

5. **Brevo** - get an API key, set via
   `npx convex env set BREVO_API_KEY ...`.

6. **QR signing secret** - generate one with `openssl rand -hex 32`, set
   via `npx convex env set QR_SIGNING_SECRET ...`. Never commit this.

7. **Webhook URL** - point Moolre's payment webhook at
   `https://your-deployment.convex.site/moolre/webhook` (note: `.convex.site`,
   not `.convex.cloud` - that's the HTTP actions domain).

## Running the frontend locally

```
npm run serve
```

Serves `public/` on `http://localhost:8080`.

## Deliberate product decisions baked into this code

- **No transfer, no resale** - see `schema.ts` comments. Simplifies
  fraud surface and refund routing considerably.
- **All sales final except cancellation; service fee never refunded** -
  matches industry-standard (Ticketmaster) policy.
- **Fee shown itemized before payment**, not revealed at the last step.
- **Guest checkout is the default path** - name + phone only, no
  password, no account wall before paying.

## Known gaps (intentionally out of scope for the initial build)

- Escrow/ledger and payout batching to organizers
- Cancellation to cascading refund automation - `setEventStatus` in
  `convex/events.ts` deliberately only allows the draft/published
  toggle, not cancellation, until a refund flow exists to go with it
- Admin/ops tooling (e.g. reviewing `organizerInquiries` submissions,
  which still land in the database with no UI to view/action them)
- Clerk-based optional account claim after guest purchase
- Moolre webhook signature verification (`convex/http.ts` has a `TODO`
  - the webhook currently trusts the request body without verifying it
  came from Moolre)

See the project's 6-month roadmap discussion for when these come in.
