// Runs as part of the Vercel build (see vercel.json), right after
// write-convex-config.js. Queries published events over Convex's HTTP query
// API (docs.convex.dev/http-api) at build time so sitemap.xml lists real,
// current event URLs - this project has no SSR beyond the single-event SEO
// bridge in convex/http.ts, so a listing page has to be assembled here
// instead. Never fails the build: a missing/unreachable Convex deployment
// just means the sitemap falls back to static pages only.
const fs = require("fs");
const path = require("path");

const SITE_ORIGIN = "https://nsaatickets.com";

const STATIC_PAGES = [
  "/",
  "/about",
  "/pricing",
  "/faq",
  "/organizers",
  "/venues",
  "/blog",
  "/contact",
  "/organizer-signup",
  "/organizer-inquiry",
  "/privacy-policy",
  "/terms-of-service",
  "/refund-and-cancellation-policy",
  "/cookie-policy",
  "/acceptable-use-policy",
  "/security-policy",
  "/accessibility-statement",
  "/copyright-dmca",
  "/dpa",
];

async function fetchPublishedEventSlugs() {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) return [];

  try {
    const slugs = [];
    let page = 1;
    for (;;) {
      const response = await fetch(`${convexUrl}/api/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "events:searchPublishedPage",
          args: { page, pageSize: 48 },
          format: "json",
        }),
      });
      const payload = await response.json();
      if (payload.status !== "success") break;
      const { items, hasNextPage } = payload.value;
      for (const event of items) {
        if (event.slug) slugs.push(event.slug);
      }
      if (!hasNextPage) break;
      page += 1;
    }
    return slugs;
  } catch (err) {
    console.warn(
      `Could not fetch published events for sitemap.xml, falling back to static pages only: ${err.message}`,
    );
    return [];
  }
}

async function main() {
  const eventSlugs = await fetchPublishedEventSlugs();
  const urls = [
    ...STATIC_PAGES.map((p) => `${SITE_ORIGIN}${p}`),
    ...eventSlugs.map((slug) => `${SITE_ORIGIN}/events/${encodeURIComponent(slug)}`),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${url}</loc></url>`).join("\n")}
</urlset>
`;

  const outPath = path.join(__dirname, "..", "public", "sitemap.xml");
  fs.writeFileSync(outPath, xml);
  console.log(`Wrote ${outPath} with ${urls.length} URLs (${eventSlugs.length} events).`);
}

main();
