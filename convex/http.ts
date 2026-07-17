import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { escapeHtml } from "./email";

const http = httpRouter();

const SITE_ORIGIN = "https://nsaatickets.com";
const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/logo.jpeg`;

// Shared shell for both the "found" and "not found" cases below - same
// markup/scripts as public/event.html, just with the <head> filled in
// server-side with real per-event data instead of the client-only
// document.title update event-page.js does after load. Root-relative
// asset paths (/js/..., /css/...) resolve against the real site domain
// because the Vercel rewrite that lands requests here (see vercel.json)
// is a transparent proxy, not a redirect - the address bar never changes.
function renderEventShellHtml(params: {
  title: string;
  description: string;
  canonicalUrl: string;
  ogImage: string;
  noindex?: boolean;
  jsonLd?: unknown;
}): string {
  const { title, description, canonicalUrl, ogImage, noindex, jsonLd } = params;
  return `<!doctype html>
<html lang="en" data-bs-theme="light">
  <head>
    <meta charset="UTF-8" />
    <meta name="color-scheme" content="only light" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/jpeg" href="/fav.jpg" />
    <link rel="apple-touch-icon" href="/fav.jpg" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
    ${noindex ? '<meta name="robots" content="noindex" />' : ""}
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
    ${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ""}
    <script type="module" src="/js/nsaa-chrome.js"></script>
    <link
      href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"
      rel="stylesheet"
    />
    <link href="/css/nsaa.css" rel="stylesheet" />
    <script src="https://unpkg.com/@phosphor-icons/web"></script>
  </head>
  <body>
    <div id="nsaa-chrome-nav"></div>

    <script src="/js/clerk-config.js"></script>
    <script src="/js/clerk-loader.js"></script>

    <main id="event-root">
      <section class="container py-5">
        <div id="event-loading"></div>
      </section>
    </main>

    <div id="nsaa-chrome-footer"></div>

    <script src="/js/convex-config.js"></script>
    <script src="/js/nsaa.js"></script>
    <script type="module" src="/js/event-page.js"></script>
    <script src="/js/clerk-nav.js"></script>
  </body>
</html>`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

// Server-rendered bridge for crawlers and link-unfurlers (Googlebot,
// Facebook/Twitter/WhatsApp preview bots) that never execute the SPA's
// client-side rendering - see public/js/event-page.js, which only sets
// document.title after data loads, and so never gets a chance to run
// before those bots read the page. vercel.json rewrites
// /events/:slug here so the address bar keeps the real domain.
http.route({
  path: "/seo/event",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug") ?? "";
    const canonicalUrl = `${SITE_ORIGIN}/events/${encodeURIComponent(slug)}`;

    const event = slug ? await ctx.runQuery(api.events.getBySlug, { slug }) : null;
    if (!event) {
      return new Response(
        renderEventShellHtml({
          title: "Event not found | Nsaa Tickets",
          description: "This event may have been removed or the link may be incomplete.",
          canonicalUrl,
          ogImage: DEFAULT_OG_IMAGE,
          noindex: true,
        }),
        { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    const ticketTypes = await ctx.runQuery(api.events.ticketTypesForEvent, {
      eventId: event._id,
    });
    const prices = ticketTypes.map((t) => t.priceGHS);
    const minPrice = prices.length ? Math.min(...prices) : undefined;

    const description = truncate(event.description, 200);
    const ogImage = event.heroImageUrl || DEFAULT_OG_IMAGE;

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "Event",
      name: event.title,
      startDate: new Date(event.startsAt).toISOString(),
      ...(event.endsAt ? { endDate: new Date(event.endsAt).toISOString() } : {}),
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      eventStatus:
        event.status === "cancelled"
          ? "https://schema.org/EventCancelled"
          : "https://schema.org/EventScheduled",
      location: {
        "@type": "Place",
        name: event.venue,
        address: {
          "@type": "PostalAddress",
          streetAddress: event.address,
          addressLocality: event.city,
          addressCountry: "GH",
        },
      },
      image: [ogImage],
      description,
      organizer: { "@type": "Organization", name: event.organizerName },
      ...(minPrice !== undefined
        ? {
            offers: {
              "@type": "Offer",
              price: minPrice,
              priceCurrency: "GHS",
              url: canonicalUrl,
              availability: "https://schema.org/InStock",
            },
          }
        : {}),
    };

    return new Response(
      renderEventShellHtml({
        title: `${event.title} | Nsaa Tickets`,
        description,
        canonicalUrl,
        ogImage,
        jsonLd,
      }),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }),
});

// Moolre calls this endpoint when a payment or transfer's status changes.
// Verified against docs.moolre.com (Payment Webhook): POST body shape is
// { status, code, message, data: { externalref, transactionid, ... } }.
// Moolre's docs don't document a signature/verification header, so this
// handler doesn't trust the body's status at all - it only uses
// `data.externalref` to know which record to re-check, then verifies the
// real status via Moolre's own status endpoint (see
// convex/moolre.ts:verifyAndProcessPayment and
// convex/payouts.ts:verifyAndProcessPayout).
//
// One webhook URL handles customer payments (collections), organizer
// payouts, Nsaa service-fee sweeps, and admin-issued refunds (transfers)
// - Moolre registers one callback per account, not per transaction type -
// so externalref is always sent as `order:<id>`, `payout:<id>`,
// `fee:<id>`, or `refund:<id>:<ts>` and routed here by prefix.
//
// This URL must be registered as the account's webhook/callback URL in
// the Moolre dashboard (or via POST /open/account/update's `callback`
// field) - Moolre has no per-request callback field.
http.route({
  path: "/moolre/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const externalref: string | undefined = body?.data?.externalref;

    if (!externalref) {
      return new Response("Missing data.externalref", { status: 400 });
    }

    const [prefix = "", id = ""] = externalref.split(":");

    if (prefix === "order" && id) {
      await ctx.runAction(internal.moolre.verifyAndProcessPayment, {
        externalref,
        orderId: id as Id<"orders">,
      });
    } else if (prefix === "payout" && id) {
      await ctx.runAction(internal.payouts.verifyAndProcessPayout, {
        externalref,
        payoutId: id as Id<"payouts">,
      });
    } else if (prefix === "fee" && id) {
      await ctx.runAction(internal.serviceFees.verifyAndProcessServiceFeeTransfer, {
        externalref,
        transferId: id as Id<"serviceFeeTransfers">,
      });
    } else if (prefix === "refund" && id) {
      await ctx.runAction(internal.ordersAdmin.verifyAndProcessRefund, {
        externalref,
        orderId: id as Id<"orders">,
      });
    } else {
      console.error(`Unrecognized Moolre externalref format: ${externalref}`);
      return new Response("Unrecognized externalref", { status: 400 });
    }

    return new Response("ok", { status: 200 });
  }),
});

// Serves a ticket's QR code as a real fetchable PNG, so the confirmation
// email (convex/moolre.ts:sendConfirmation) can use a normal <img
// src="..."> instead of an inline base64 data: URI - Gmail strips inline
// data: image URIs from HTML email, so a hosted URL is the only approach
// that renders everywhere. Generation happens on-demand (not cached in
// storage) since a ticket's token never changes once issued.
http.route({
  path: "/tickets/qr",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const ticketId = url.searchParams.get("ticketId");
    if (!ticketId) {
      return new Response("Missing ticketId", { status: 400 });
    }

    const ticket = await ctx.runQuery(internal.tickets.getTicketInternal, {
      ticketId: ticketId as Id<"tickets">,
    });
    if (!ticket) {
      return new Response("Not found", { status: 404 });
    }

    const base64: string = await ctx.runAction(internal.qrImage.tokenToPngBase64, {
      token: ticket.qrToken,
    });
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }),
});

export default http;
