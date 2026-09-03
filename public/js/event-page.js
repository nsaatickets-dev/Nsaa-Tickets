// Event detail page logic. Extracted out of event.html so the exact same
// script can be loaded by the server-rendered SEO bridge at /events/<slug>
// (see convex/http.ts's /seo/event route + the vercel.json rewrite) as well
// as the legacy client-only /event.html?slug=... route - both need
// identical behavior, so there is exactly one copy of this logic.
import { ConvexClient } from "https://esm.sh/convex/browser";

const params = new URLSearchParams(window.location.search);
// Canonical URLs are path-based (/events/<slug>, via the Vercel rewrite to
// Convex's SEO HTTP route); ?slug=/&id= query params are kept working for
// the legacy /event.html route and any existing bookmarks/links.
const pathSlugMatch = window.location.pathname.match(/^\/events\/([^/]+)\/?$/);
const eventId = params.get("id");
const eventSlug = params.get("slug") || (pathSlugMatch ? decodeURIComponent(pathSlugMatch[1]) : "");
const referralCode = params.get("ref") || "";
const root = document.getElementById("event-root");
let currentEvent = null;
let currentTicketTypes = [];
let client = null;
let unsubscribeTicketTypes = null;

document.getElementById("event-loading").innerHTML = NSAA.loading(
  "Loading event details",
);

function serviceFee(subtotal) {
  return Math.floor(subtotal * 0.045 * 100) / 100;
}

const DAY_MS = 24 * 60 * 60 * 1000;
function dayStartMs(ts) {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}
// Mirrors convex/tickets.ts's eventDayList - every calendar day the event
// spans, as UTC-midnight timestamps.
function eventDayList(event) {
  const start = dayStartMs(event.startsAt);
  const end = dayStartMs(event.endsAt ?? event.startsAt);
  const days = [];
  for (let day = start; day <= end; day += DAY_MS) days.push(day);
  return days;
}

// A "Day 2" / "Days 2-3" badge for a day-scoped tier. No badge for a full
// multi-day pass (unset/empty validDayTimestamps) or an ordinary
// single-day event - no visual change for the vast majority of events.
function ticketDayBadgeHtml(ticket, eventDays) {
  if (eventDays.length <= 1) return "";
  if (!ticket.validDayTimestamps || ticket.validDayTimestamps.length === 0) return "";
  const indices = ticket.validDayTimestamps
    .map((day) => eventDays.indexOf(day) + 1)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (!indices.length) return "";
  const label = indices.length === 1 ? `Day ${indices[0]}` : `Days ${indices.join(", ")}`;
  return `<span class="nsaa-chip" data-tone="gold">${NSAA.escapeHtml(label)}</span>`;
}

function eventShareUrl(event) {
  return `${window.location.origin}/events/${encodeURIComponent(event.slug || event._id)}`;
}

async function handleShareClick(button, event) {
  const url = eventShareUrl(event);
  const shareData = {
    title: event.title,
    text: `${event.title} — ${NSAA.formatDateRange(event.startsAt, event.endsAt)} at ${event.venue}, ${event.city}`,
    url,
  };
  if (navigator.share) {
    try {
      await navigator.share(shareData);
      return;
    } catch (err) {
      return; // user cancelled - don't fall through to the clipboard toast
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    const original = button.innerHTML;
    button.innerHTML = '<i class="ph ph-check me-2"></i>Link copied';
    setTimeout(() => {
      button.innerHTML = original;
    }, 2000);
  } catch (err) {
    await NSAA.promptDialog({
      title: "Copy this link",
      label: "Event link",
      defaultValue: url,
      readonly: true,
      required: false,
      confirmLabel: "Done",
      cancelLabel: "Close",
    });
  }
}

// Breadcrumb trail is rebuilt per event (Home > Category > Event title) and
// paired with its own BreadcrumbList JSON-LD - this page is fully
// client-rendered, so both the visible nav and the schema have to be built
// here rather than statically like the rest of the site's inner pages (see
// NSAA's static breadcrumb blocks on about/faq/pricing/etc).
function renderBreadcrumb(event, meta) {
  const trail = [
    { label: "Home", href: "/" },
    { label: meta.label, href: `/?category=${encodeURIComponent(event.category || "")}` },
    { label: event.title },
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.label,
      ...(item.href ? { item: `${window.location.origin}${item.href}` } : {}),
    })),
  };

  let schemaScript = document.getElementById("event-breadcrumb-schema");
  if (!schemaScript) {
    schemaScript = document.createElement("script");
    schemaScript.type = "application/ld+json";
    schemaScript.id = "event-breadcrumb-schema";
    document.head.appendChild(schemaScript);
  }
  schemaScript.textContent = JSON.stringify(jsonLd);

  const trailHtml = trail
    .map((item, index) => {
      const isLast = index === trail.length - 1;
      if (isLast || !item.href) {
        return `<span class="nsaa-breadcrumb-current" aria-current="page">${NSAA.escapeHtml(item.label)}</span>`;
      }
      return `<a href="${NSAA.escapeAttr(item.href)}">${NSAA.escapeHtml(item.label)}</a>`;
    })
    .join('<i class="ph ph-caret-right nsaa-breadcrumb-sep" aria-hidden="true"></i>');

  return `<nav class="nsaa-breadcrumbs" aria-label="Breadcrumb"><div class="container">${trailHtml}</div></nav>`;
}

function renderEvent(event) {
  if (!event) {
    document.body.classList.remove("nsaa-has-sticky-cta");
    root.innerHTML = `<section class="container py-5">${NSAA.emptyState("Event not found", "The event may have been removed or the link may be incomplete.", '<a class="btn btn-nsaa" href="/">Back to discovery</a>')}</section>`;
    return;
  }

  currentEvent = event;
  if (client) {
    if (unsubscribeTicketTypes) unsubscribeTicketTypes();
    unsubscribeTicketTypes = client.onUpdate(
      "events:ticketTypesForEvent",
      { eventId: event._id },
      renderTicketTypes,
    );
  }
  const meta = NSAA.categoryMeta(event.category);
  const image = NSAA.eventImage(event);
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${event.venue} ${event.address} ${event.city} Ghana`)}`;
  const venueLink = event.venueSlug ? `/venues?slug=${encodeURIComponent(event.venueSlug)}` : mapUrl;
  const organizerLink = event.organizerSlug ? `/organizers?slug=${encodeURIComponent(event.organizerSlug)}` : "/organizers";
  const whatsappShareUrl = `https://wa.me/?text=${encodeURIComponent(`${event.title} — ${eventShareUrl(event)}`)}`;
  document.title = `${event.title} | Nsaa Tickets`;

  root.innerHTML = `
  ${renderBreadcrumb(event, meta)}
  <header class="nsaa-event-detail-hero" style="background-image: url('${NSAA.escapeAttr(image)}');">
    <div class="container py-5">
      <span class="nsaa-chip mb-3" data-tone="${NSAA.escapeAttr(meta.tone)}">${NSAA.escapeHtml(meta.shortLabel)}</span>
      <h1 class="nsaa-page-title mb-3">${NSAA.escapeHtml(event.title)}</h1>
      <div class="d-flex flex-wrap align-items-center gap-3">
        <p class="lead nsaa-muted mb-0">${NSAA.escapeHtml(event.venue)}, ${NSAA.escapeHtml(event.city)}</p>
        <button id="event-share-btn" class="btn btn-nsaa btn-sm" type="button"><i class="ph ph-share-network me-2"></i>Share</button>
        <a class="btn btn-nsaa btn-sm" href="${NSAA.escapeAttr(whatsappShareUrl)}" target="_blank" rel="noreferrer"><i class="ph ph-whatsapp-logo me-2"></i>WhatsApp</a>
      </div>
    </div>
  </header>

  <section class="container py-5">
    <div class="row g-4">
      <div class="col-lg-7">
        <div class="nsaa-meta-grid mb-4">
          <div class="nsaa-meta-item d-flex align-items-center gap-3">
            <span class="nsaa-icon-badge flex-shrink-0"><i class="ph ph-calendar-blank nsaa-trust-icon"></i></span>
            <div>
              <p class="nsaa-faint small mb-1">Date and time</p>
              <p class="mb-0 fw-semibold">${NSAA.escapeHtml(NSAA.formatDateRange(event.startsAt, event.endsAt, "long"))}</p>
            </div>
          </div>
          <div class="nsaa-meta-item d-flex align-items-center gap-3">
            <span class="nsaa-icon-badge flex-shrink-0"><i class="ph ph-map-pin nsaa-trust-icon"></i></span>
            <div>
              <p class="nsaa-faint small mb-1">Venue</p>
              <p class="mb-0 fw-semibold"><a href="${NSAA.escapeAttr(venueLink)}">${NSAA.escapeHtml(event.venue)}</a></p>
            </div>
          </div>
          <div class="nsaa-meta-item d-flex align-items-center gap-3">
            <span class="nsaa-icon-badge flex-shrink-0"><i class="ph ph-user-focus nsaa-trust-icon"></i></span>
            <div>
              <p class="nsaa-faint small mb-1">Organizer</p>
              <p class="mb-0 fw-semibold"><a href="${NSAA.escapeAttr(organizerLink)}">${NSAA.escapeHtml(event.organizerName)}</a></p>
            </div>
          </div>
          <div class="nsaa-meta-item d-flex align-items-center gap-3">
            <span class="nsaa-icon-badge flex-shrink-0"><i class="ph ph-globe nsaa-trust-icon"></i></span>
            <div>
              <p class="nsaa-faint small mb-1">City</p>
              <p class="mb-0 fw-semibold">${NSAA.escapeHtml(event.city)}</p>
            </div>
          </div>
        </div>

        <h2 class="h4 mb-3">About this event</h2>
        <p class="nsaa-muted fs-5 mb-4">${NSAA.escapeHtml(event.description)}</p>

        <div class="nsaa-panel">
          <h3 class="h5 mb-2">${NSAA.escapeHtml(event.venue)}</h3>
          <p class="nsaa-muted mb-3">${NSAA.escapeHtml(event.address)}, ${NSAA.escapeHtml(event.city)}</p>
          <div class="d-flex flex-wrap gap-2">
            <a class="btn btn-nsaa" href="${NSAA.escapeAttr(mapUrl)}" target="_blank" rel="noreferrer"><i class="ph ph-map-trifold me-2"></i>Open map</a>
            <a class="btn btn-nsaa" href="${NSAA.escapeAttr(venueLink)}"><i class="ph ph-buildings me-2"></i>Venue profile</a>
          </div>
        </div>
      </div>

      <aside class="col-lg-5">
        <div class="nsaa-panel position-sticky" style="top: 88px;">
          <h2 class="h4 mb-3">Choose a ticket type</h2>
          <div id="ticket-types" style="scroll-margin-top: 96px;">${NSAA.skeletonTickets(2)}</div>
        </div>
      </aside>
    </div>
  </section>

  <div class="nsaa-sticky-cta" id="event-sticky-cta">
    <div class="nsaa-sticky-cta-inner">
      <div class="nsaa-sticky-cta-copy">
        <strong>${NSAA.escapeHtml(event.title)}</strong>
        <span>${NSAA.escapeHtml(NSAA.formatDateRange(event.startsAt, event.endsAt))}</span>
      </div>
      <a class="btn btn-nsaa" href="#ticket-types">Buy tickets</a>
    </div>
  </div>
`;

  document.body.classList.add("nsaa-has-sticky-cta");

  document.getElementById("event-share-btn")?.addEventListener("click", (evt) => {
    handleShareClick(evt.currentTarget, event);
  });

  renderTicketTypes(currentTicketTypes);
}

function renderTicketTypes(types) {
  currentTicketTypes = types || [];
  const container = document.getElementById("ticket-types");
  if (!container) return;

  if (!currentTicketTypes.length) {
    container.innerHTML = NSAA.emptyState(
      "Tickets are not available yet",
      "The organizer has not published ticket tiers for this event.",
    );
    return;
  }

  const sortedTiers = [...currentTicketTypes].sort((a, b) => b.priceGHS - a.priceGHS);
  const eventDays = eventDayList(currentEvent);

  container.innerHTML = sortedTiers
    .map((ticket, index) => {
      const subtotal = ticket.priceGHS;
      const fee = ticket.serviceFeeGHS ?? serviceFee(subtotal);
      const total = ticket.totalPerTicketGHS ?? subtotal + fee;
      const soldOut = ticket.quantityAvailable <= 0;
      const availability = soldOut
        ? "Sold out"
        : ticket.quantityAvailable <= 10
          ? `${ticket.quantityAvailable} left`
          : `${ticket.quantityAvailable} available`;
      const presentation = NSAA.tierPresentation(ticket.name, index);
      const dayBadge = ticketDayBadgeHtml(ticket, eventDays);

      return `
    <article class="nsaa-card nsaa-tier-card p-3 mb-3" style="border-left-color: ${NSAA.escapeAttr(presentation.accentHex)};">
      <div class="nsaa-ticket-row">
        <div>
          <div class="d-flex align-items-center justify-content-between gap-3 mb-2">
            <h3 class="h5 mb-0"><i class="ph ${NSAA.escapeAttr(presentation.icon)} me-2" style="color: ${NSAA.escapeAttr(presentation.accentHex)};"></i>${NSAA.escapeHtml(ticket.name)} ${dayBadge}</h3>
            <span class="nsaa-chip" data-tone="${soldOut ? "rose" : "green"}">${NSAA.escapeHtml(availability)}</span>
          </div>
          <div class="nsaa-price-breakdown p-3">
            <div class="d-flex justify-content-between small py-1">
              <span class="nsaa-muted">Ticket price</span>
              <span>${NSAA.money(ticket.priceGHS)}</span>
            </div>
            <div class="d-flex justify-content-between small py-1">
              <span class="nsaa-muted">Service fee</span>
              <span>${NSAA.money(fee)}</span>
            </div>
            <div class="d-flex justify-content-between fw-semibold pt-2 mt-2 nsaa-divider-dashed">
              <span>Total per ticket</span>
              <span style="color: var(--nsaa-gold);">${NSAA.money(total)}</span>
            </div>
          </div>
        </div>
        <a class="btn btn-nsaa ${soldOut ? "disabled" : ""}" href="/checkout?eventId=${encodeURIComponent(currentEvent._id)}&ticketTypeId=${encodeURIComponent(ticket._id)}${referralCode ? `&ref=${encodeURIComponent(referralCode)}` : ""}" aria-disabled="${soldOut ? "true" : "false"}">${soldOut ? "Sold out" : "Buy ticket"}</a>
      </div>
    </article>
  `;
    })
    .join("");
}

if (!eventId && !eventSlug) {
  root.innerHTML = `<section class="container py-5">${NSAA.emptyState("No event selected", "Choose an event from discovery to view ticket options.", '<a class="btn btn-nsaa" href="/">Browse events</a>')}</section>`;
} else if (!NSAA.isConvexConfigured()) {
  root.innerHTML = `<section class="container py-5">${NSAA.setupNotice("Event detail")}</section>`;
} else {
  client = new ConvexClient(NSAA.CONVEX_URL);
  const eventArgs = {};
  if (eventId) eventArgs.eventId = eventId;
  if (eventSlug) eventArgs.slug = eventSlug;
  client.onUpdate("events:getPublicEvent", eventArgs, renderEvent);
}
