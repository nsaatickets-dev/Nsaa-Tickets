(function () {
  // Injectable per-deployment, same pattern as clerk-config.js - lets
  // Vercel's build step point each preview deployment at its own fresh
  // Convex backend (see convex-config.js, scripts/write-convex-config.js,
  // vercel.json). Falls back to the known production URL for local dev
  // via `npm run serve`, where no build step runs to generate the file.
  const CONVEX_URL =
    window.NSAA_CONVEX_CONFIG?.url || "https://adjoining-aardvark-475.convex.cloud";

  const categories = [
    {
      value: "concert",
      label: "Concerts",
      shortLabel: "Concert",
      tone: "teal",
      description: "Live music, festivals, listening rooms",
      image:
        "https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=1200&q=80",
    },
    {
      value: "nightlife",
      label: "Nightlife",
      shortLabel: "Nightlife",
      tone: "rose",
      description: "Curated parties, rooftops, club nights",
      image:
        "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1200&q=80",
    },
    {
      value: "conference",
      label: "Conferences",
      shortLabel: "Conference",
      tone: "blue",
      description: "Summits, expos, professional forums",
      image:
        "https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1200&q=80",
    },
    {
      value: "sports",
      label: "Sports",
      shortLabel: "Sports",
      tone: "green",
      description: "Matches, screenings, tournaments",
      image:
        "https://images.unsplash.com/photo-1505842465776-3d90f6163103?auto=format&fit=crop&w=1200&q=80",
    },
    {
      value: "wedding",
      label: "Weddings",
      shortLabel: "Wedding",
      tone: "rose",
      description: "Showcases, ceremonies, vendor fairs",
      image:
        "https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80",
    },
    {
      value: "comedy",
      label: "Comedy",
      shortLabel: "Comedy",
      tone: "teal",
      description: "Stand-up, improv, live specials",
      image:
        "https://images.unsplash.com/photo-1527224857830-43a7acc85260?auto=format&fit=crop&w=1200&q=80",
    },
    {
      value: "theatre",
      label: "Theatre",
      shortLabel: "Theatre",
      tone: "blue",
      description: "Drama, dance, spoken word, stage",
      image:
        "https://images.unsplash.com/photo-1503095396549-807759245b35?auto=format&fit=crop&w=1200&q=80",
    },
    {
      value: "religious",
      label: "Religious",
      shortLabel: "Religious",
      tone: "green",
      description: "Worship, conferences, gatherings",
      image:
        "https://images.unsplash.com/photo-1438232992991-995b7058bbb3?auto=format&fit=crop&w=1200&q=80",
    },
    {
      value: "workshop",
      label: "Workshops",
      shortLabel: "Workshop",
      tone: "blue",
      description: "Classes, practical training, clinics",
      image:
        "https://images.unsplash.com/photo-1517048676732-d65bc937f952?auto=format&fit=crop&w=1200&q=80",
    },
  ];

  const categoryByValue = new Map(categories.map((item) => [item.value, item]));

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll("`", "&#096;");
  }

  function money(value) {
    const amount = Number(value ?? 0);
    return `GHS ${amount.toFixed(2)}`;
  }

  function formatDate(value, mode = "short") {
    if (!value) return "Date to be announced";
    const date = new Date(value);
    const options =
      mode === "long"
        ? {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }
        : {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          };
    return date.toLocaleString(undefined, options);
  }

  function categoryMeta(value) {
    return (
      categoryByValue.get(value) ?? {
        value,
        label: titleCase(value || "Event"),
        shortLabel: titleCase(value || "Event"),
        tone: "teal",
        description: "Event experience",
        image: categories[0].image,
      }
    );
  }

  function titleCase(value) {
    return String(value ?? "")
      .split(/[\s-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function eventImage(event) {
    return event?.heroImageUrl || categoryMeta(event?.category).image;
  }

  function eventCard(event, options = {}) {
    const meta = categoryMeta(event.category);
    const image = eventImage(event);
    const date = formatDate(event.startsAt);
    const href =
      options.href || `event.html?id=${encodeURIComponent(event._id)}`;
    const cityLine = [event.venue, event.city].filter(Boolean).join(", ");
    const staggerIndex = Number.isFinite(options.index) ? options.index : 0;
    return `
      <div class="${escapeAttr(options.colClass || "col-md-6 col-xl-4")} nsaa-stagger-item" style="--stagger-index: ${staggerIndex};">
        <a class="text-decoration-none d-block h-100" href="${escapeAttr(href)}">
          <article class="nsaa-card nsaa-event-card h-100">
            <div class="nsaa-event-media" style="background-image: linear-gradient(180deg, rgba(15,14,17,0.02), rgba(15,14,17,0.42)), url('${escapeAttr(image)}');"></div>
            <div class="nsaa-event-body">
              <div class="d-flex align-items-center justify-content-between gap-2 mb-3">
                <span class="nsaa-chip" data-tone="${escapeAttr(meta.tone)}">${escapeHtml(meta.shortLabel)}</span>
                <span class="nsaa-faint small">${escapeHtml(event.city)}</span>
              </div>
              <h3 class="h5 text-white mb-2">${escapeHtml(event.title)}</h3>
              <p class="nsaa-muted small mb-2">${escapeHtml(cityLine)}</p>
              <p class="nsaa-faint small mb-0">${escapeHtml(date)}</p>
            </div>
          </article>
        </a>
      </div>
    `;
  }

  function setupNotice(pageName) {
    return `
      <div class="nsaa-card nsaa-empty p-4">
        <div>
          <p class="nsaa-eyebrow mb-2">Setup needed</p>
          <h2 class="h4 mb-2">${escapeHtml(pageName)} is ready for Convex.</h2>
          <p class="nsaa-muted mb-0">Replace <code>CONVEX_URL</code> in <code>public/js/nsaa.js</code> with your Convex deployment URL from <code>npx convex dev</code>.</p>
        </div>
      </div>
    `;
  }

  function loading(label = "Loading") {
    return `
      <div class="nsaa-card nsaa-empty p-4">
        <div>
          <p class="nsaa-muted mb-3">${escapeHtml(label)}</p>
          <span class="nsaa-progress-dots" aria-hidden="true"><span></span><span></span><span></span></span>
        </div>
      </div>
    `;
  }

  function emptyState(title, body, actionHtml = "") {
    return `
      <div class="nsaa-card nsaa-empty p-4">
        <div>
          <h2 class="h4 mb-2">${escapeHtml(title)}</h2>
          <p class="nsaa-muted mb-3">${escapeHtml(body)}</p>
          ${actionHtml}
        </div>
      </div>
    `;
  }

  function errorState(title, body) {
    return `
      <div class="nsaa-status-box failed">
        <p class="fw-semibold mb-1">${escapeHtml(title)}</p>
        <p class="mb-0">${escapeHtml(body)}</p>
      </div>
    `;
  }

  function isConvexConfigured() {
    return Boolean(CONVEX_URL && !CONVEX_URL.includes("REPLACE_ME"));
  }

  async function getClerk() {
    if (window.NSAAClerkReady) {
      return await window.NSAAClerkReady;
    }

    return window.Clerk ?? null;
  }

  async function attachConvexAuth(client) {
    if (!client || typeof client.setAuth !== "function") {
      return false;
    }

    try {
      const clerk = await getClerk();
      if (!clerk) return false;

      client.setAuth(async () => {
        if (!clerk.session) return null;
        // No named JWT template here on purpose - Clerk's current Convex
        // integration (dashboard.clerk.com/apps/setup/convex) maps the
        // `aud: "convex"` claim onto the default session token directly,
        // it doesn't create a separate named template the way the older
        // integration flow used to.
        return await clerk.session.getToken();
      });
      return true;
    } catch (err) {
      console.warn("Convex auth could not attach to Clerk", err);
      return false;
    }
  }

  function isValidGhanaPhone(phone) {
    if (!phone) return false;
    const clean = phone.replace(/[\s\-\+\(\)]/g, "");
    if (/^233\d{9}$/.test(clean)) return true;
    if (/^0\d{9}$/.test(clean)) return true;
    return false;
  }

  function isValidEmail(email) {
    if (!email) return true; // optional
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  function skeletonCards(count = 3) {
    let cards = "";
    for (let i = 0; i < count; i++) {
      cards += `
        <div class="col-md-6 col-xl-4">
          <div class="nsaa-card nsaa-event-card-skeleton">
            <div class="skeleton-image skeleton-shimmer"></div>
            <div class="nsaa-event-body">
              <div class="d-flex align-items-center justify-content-between mb-3">
                <div class="skeleton-chip skeleton-shimmer"></div>
                <div class="skeleton-text-short skeleton-shimmer"></div>
              </div>
              <div class="skeleton-title skeleton-shimmer mb-2"></div>
              <div class="skeleton-text-medium skeleton-shimmer mb-2"></div>
              <div class="skeleton-text-short skeleton-shimmer"></div>
            </div>
          </div>
        </div>
      `;
    }
    return cards;
  }

  function skeletonTickets(count = 2) {
    let html = "";
    for (let i = 0; i < count; i++) {
      html += `
        <div class="nsaa-card p-3 mb-3">
          <div class="nsaa-ticket-row">
            <div class="w-100 me-lg-3">
              <div class="d-flex align-items-center justify-content-between mb-3">
                <div class="skeleton-title skeleton-shimmer" style="width: 40%; height: 20px;"></div>
                <div class="skeleton-chip skeleton-shimmer" style="width: 80px; height: 24px;"></div>
              </div>
              <div class="p-3 nsaa-price-breakdown">
                <div class="d-flex justify-content-between mb-2"><div class="skeleton-text-short skeleton-shimmer" style="width: 30%;"></div><div class="skeleton-text-short skeleton-shimmer" style="width: 20%;"></div></div>
                <div class="d-flex justify-content-between mb-2"><div class="skeleton-text-short skeleton-shimmer" style="width: 30%;"></div><div class="skeleton-text-short skeleton-shimmer" style="width: 20%;"></div></div>
                <div class="d-flex justify-content-between pt-2 nsaa-divider-dashed"><div class="skeleton-text-short skeleton-shimmer" style="width: 40%; height: 18px;"></div><div class="skeleton-text-short skeleton-shimmer" style="width: 25%; height: 18px;"></div></div>
              </div>
            </div>
            <div class="skeleton-chip skeleton-shimmer mt-3 mt-lg-0" style="width: 100px; height: 44px; border-radius: 8px;"></div>
          </div>
        </div>
      `;
    }
    return html;
  }

  function initCookieBanner() {
    const STORAGE_KEY = "nsaa:cookieConsent";
    let alreadyConsented = true;
    try {
      alreadyConsented = Boolean(window.localStorage.getItem(STORAGE_KEY));
    } catch (err) {
      return; // localStorage unavailable - don't block rendering over it
    }
    if (alreadyConsented) return;

    document.addEventListener("DOMContentLoaded", () => {
      const banner = document.createElement("div");
      banner.id = "nsaa-cookie-banner";
      banner.className = "nsaa-cookie-banner";
      banner.innerHTML = `
        <div class="container d-flex flex-column flex-sm-row align-items-sm-center justify-content-between gap-3 py-3">
          <p class="nsaa-muted small mb-0">We use essential cookies and local storage to keep checkout and sign-in working. <a href="cookie-policy.html">Learn more</a>.</p>
          <button id="nsaa-cookie-accept" class="btn btn-nsaa btn-sm flex-shrink-0" type="button">Got it</button>
        </div>
      `;
      document.body.appendChild(banner);
      document.getElementById("nsaa-cookie-accept").addEventListener("click", () => {
        try {
          window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
        } catch (err) {
          // ignore - banner still dismisses for this page view
        }
        banner.remove();
      });
    });
  }

  initCookieBanner();

  function initNewsletterForms() {
    document.addEventListener("DOMContentLoaded", async () => {
      const forms = document.querySelectorAll("[data-newsletter-form]");
      if (forms.length === 0) return;

      if (!isConvexConfigured()) {
        forms.forEach((form) => {
          const btn = form.querySelector("button");
          if (btn) btn.disabled = true;
        });
        return;
      }

      const { ConvexClient } = await import("https://esm.sh/convex/browser");
      const client = new ConvexClient(CONVEX_URL);

      forms.forEach((form) => {
        const input = form.querySelector('input[type="email"]');
        const btn = form.querySelector("button");
        const resultEl = document.createElement("p");
        resultEl.className = "small mb-0 mt-1";
        form.appendChild(resultEl);

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const email = input.value.trim();

          if (!email || !isValidEmail(email)) {
            resultEl.textContent = "Enter a valid email.";
            resultEl.style.color = "var(--nsaa-danger)";
            return;
          }

          btn.disabled = true;
          try {
            await client.mutation("newsletter:subscribe", { email });
            form.reset();
            resultEl.textContent = "Subscribed.";
            resultEl.style.color = "var(--nsaa-success)";
          } catch (err) {
            resultEl.textContent = err.message || "Could not subscribe.";
            resultEl.style.color = "var(--nsaa-danger)";
          } finally {
            btn.disabled = false;
          }
        });
      });
    });
  }

  initNewsletterForms();

  function initNavToggle() {
    document.addEventListener("DOMContentLoaded", () => {
      const navbar = document.querySelector(".nsaa-navbar");
      const toggle = document.querySelector(".nsaa-nav-toggle");
      const links = document.getElementById("nsaa-nav-links");

      if (navbar) {
        const syncNavbarChrome = () => {
          navbar.classList.toggle("is-scrolled", window.scrollY > 8);
        };
        syncNavbarChrome();
        window.addEventListener("scroll", syncNavbarChrome, { passive: true });
      }

      if (!links) return;

      const navLinks = Array.from(links.querySelectorAll(".nsaa-nav-link"));

      const currentPage = window.location.pathname.split("/").pop() || "index.html";
      const inferredActiveHref =
        currentPage === "category.html" || currentPage === "event.html"
          ? "search-results.html"
          : currentPage;
      const exactActiveLink = navLinks.find(
        (link) => link.getAttribute("href") === inferredActiveHref,
      );

      if (exactActiveLink) {
        exactActiveLink.classList.add("active");
      }

      navLinks.forEach((link) => {
        if (link.classList.contains("active")) {
          link.setAttribute("aria-current", "page");
        } else {
          link.removeAttribute("aria-current");
        }
      });

      if (!toggle) return;

      const close = () => {
        links.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "Open menu");
        document.body.classList.remove("nsaa-nav-open");
      };

      toggle.addEventListener("click", () => {
        const isOpen = links.classList.toggle("is-open");
        toggle.setAttribute("aria-expanded", String(isOpen));
        toggle.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
        document.body.classList.toggle("nsaa-nav-open", isOpen);
      });

      links.addEventListener("click", (event) => {
        if (event.target.closest("a, button")) close();
      });

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") close();
      });

      document.addEventListener("click", (event) => {
        if (!links.classList.contains("is-open")) return;
        if (links.contains(event.target) || toggle.contains(event.target)) return;
        close();
      });

      window.addEventListener("resize", () => {
        if (window.innerWidth >= 992) close();
      });
    });
  }

  initNavToggle();

  // Global safety net: an uncaught error or unhandled promise rejection
  // anywhere on the page shows a small, dismissible banner instead of the
  // page silently hanging (e.g. a stuck loading skeleton with no
  // explanation). Deliberately a banner, not a full-page takeover - it
  // doesn't know what state the rest of the page's own error handling is
  // in, so it shouldn't clobber it.
  function initGlobalErrorBanner() {
    let shown = false;

    function showBanner() {
      if (shown) return;
      shown = true;

      document.addEventListener("DOMContentLoaded", renderBanner);
      if (document.readyState !== "loading") renderBanner();
    }

    function renderBanner() {
      if (document.getElementById("nsaa-global-error-banner")) return;
      const banner = document.createElement("div");
      banner.id = "nsaa-global-error-banner";
      banner.setAttribute("role", "alert");
      banner.style.cssText =
        "position:fixed; left:0; right:0; bottom:0; z-index:2000; background:#c43d3d; color:#fff; padding:0.85rem 1rem; text-align:center; font-family:'Instrument Sans',sans-serif; font-size:0.92rem;";
      banner.innerHTML =
        'Something went wrong loading part of this page. <button type="button" style="margin-left:0.75rem; background:#fff; color:#c43d3d; border:none; border-radius:4px; padding:0.3rem 0.75rem; font-weight:700; cursor:pointer;">Refresh</button>';
      banner.querySelector("button").addEventListener("click", () => window.location.reload());
      document.body.appendChild(banner);
    }

    window.addEventListener("error", () => showBanner());
    window.addEventListener("unhandledrejection", () => showBanner());
  }

  initGlobalErrorBanner();

  window.NSAA = {
    CONVEX_URL,
    categories,
    categoryMeta,
    emptyState,
    errorState,
    escapeAttr,
    escapeHtml,
    eventCard,
    eventImage,
    attachConvexAuth,
    formatDate,
    getClerk,
    isConvexConfigured,
    loading,
    money,
    setupNotice,
    titleCase,
    isValidGhanaPhone,
    isValidEmail,
    skeletonCards,
    skeletonTickets,
  };
})();
