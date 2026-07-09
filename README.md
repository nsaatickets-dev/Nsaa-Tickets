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

3. **Clerk** - create an app at clerk.com, activate the Convex integration,
   then copy the Frontend API URL and publishable key.

   - Put the browser values in `public/js/clerk-config.js`.
   - Put `CLERK_FRONTEND_API_URL` in `.env.local` and set it for Convex with
     `npx convex env set CLERK_FRONTEND_API_URL https://your-clerk-url`.

   Checkout is guest-first by design. If a buyer is already signed in, the
   reservation is linked to their Clerk identity for the wallet. A
   post-purchase account-claim prompt is still a product follow-up.

4. **Moolre** - create/access a Moolre account, then set (see
   `.env.example` for the full list and `npx convex env set` commands):
   `MOOLRE_API_BASE`, `MOOLRE_API_USER`, `MOOLRE_API_KEY`,
   `MOOLRE_API_PUBKEY`, `MOOLRE_VASKEY`, `MOOLRE_ACCOUNT_NUMBER`,
   `MOOLRE_SMS_SENDER_ID` (must be a pre-approved sender ID). The
   collection, status-check, and SMS calls in `convex/orders.ts` and
   `convex/moolre.ts` are written against the real endpoints documented at
   docs.moolre.com - field names have been verified, not guessed.

   Moolre doesn't document a webhook signature/verification scheme, so
   `convex/http.ts`'s webhook handler doesn't trust the POSTed body at
   all - it only reads which order to check, then re-fetches the
   authoritative status from Moolre's own status endpoint before ever
   marking an order paid (see `convex/moolre.ts:verifyAndProcessPayment`).

5. **Brevo** - get an API key, set via
   `npx convex env set BREVO_API_KEY ...`.

6. **QR signing secret** - generate one with `openssl rand -hex 32`, set
   via `npx convex env set QR_SIGNING_SECRET ...`. Never commit this.

7. **Webhook URL** - Moolre has no per-request callback field; register
   your webhook once at the account level in the Moolre dashboard (or via
   `POST /open/account/update`'s `callback` field), pointing at
   `https://your-deployment.convex.site/moolre/webhook` (note:
   `.convex.site`, not `.convex.cloud` - that's the HTTP actions domain).

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
- Moolre's OTP-required collection flow (response code `TP14`) isn't
  handled - `initiateMoolrePayment` treats any `status: 1` response as
  "accepted, wait for webhook," so a channel/account config that requires
  OTP verification would need a retry-with-otpcode step added

See the project's 6-month roadmap discussion for when these come in.
