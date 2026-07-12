// Shared app-shell nav + footer, injected into the #nsaa-chrome-nav /
// #nsaa-chrome-footer mount points present on every page. Loaded as a
// module (deferred by default) so it always finishes running before
// DOMContentLoaded - nsaa.js's initNavToggle() (bound to DOMContentLoaded)
// depends on the real nav markup already being in the DOM by then.
//
// Role gating: the nav starts in the "attendee" link set for everyone
// (no flash of organizer-only links). Once Clerk confirms the visitor is
// signed in, the Attending/Organizing switcher appears - every signed-in
// user can flip into the organizer link set and self-serve their first
// event, not just people who already own one. The switcher choice is
// remembered per-browser in localStorage; the first time it's shown it
// defaults to whichever context matches the current page.

const NAV_CONTEXT_KEY = "nsaa:navContext";

function currentPage() {
  return window.location.pathname || "/";
}

function activePageForNav() {
  const page = currentPage();
  // /category and /search-results are redirect stubs into /, and /event
  // is reached from the same unified browse view - all three should
  // light up "Browse" as the active nav link.
  if (page === "/category" || page === "/search-results" || page === "/event") {
    return "/";
  }
  return page;
}

function footerHtml() {
  return `
    <footer class="nsaa-footer">
      <div class="container">
        <div class="row g-4 pb-4">
          <div class="col-lg-4">
            <a class="nsaa-brand-lockup d-inline-flex mb-3" href="/">
              <span class="nsaa-wordmark">Nsaa</span>
              <span class="nsaa-brand-tickets" aria-label="Tickets">T I C K E T S</span>
            </a>
            <p class="nsaa-muted small mb-3" style="max-width: 320px;">
              Ghana-first ticketing with clear fees and fraud-resistant entry.
            </p>
            <div class="d-flex gap-2">
              <a href="#" class="nsaa-icon-badge" aria-label="Nsaa on X"><i class="ph ph-x-logo nsaa-trust-icon"></i></a>
              <a href="#" class="nsaa-icon-badge" aria-label="Nsaa on Instagram"><i class="ph ph-instagram-logo nsaa-trust-icon"></i></a>
              <a href="#" class="nsaa-icon-badge" aria-label="Nsaa on Facebook"><i class="ph ph-facebook-logo nsaa-trust-icon"></i></a>
            </div>
          </div>
          <div class="col-6 col-lg-2">
            <p class="nsaa-faint small text-uppercase mb-3">Discover</p>
            <ul class="list-unstyled d-grid gap-2 mb-0">
              <li><a href="/" class="nsaa-muted text-decoration-none">Browse events</a></li>
              <li><a href="/venues" class="nsaa-muted text-decoration-none">Venues</a></li>
              <li><a href="/organizers" class="nsaa-muted text-decoration-none">Organizers</a></li>
              <li><a href="/organizer-inquiry#organizer-inquiry-form" class="nsaa-muted text-decoration-none">List an event</a></li>
            </ul>
          </div>
          <div class="col-6 col-lg-2">
            <p class="nsaa-faint small text-uppercase mb-3">Company</p>
            <ul class="list-unstyled d-grid gap-2 mb-0">
              <li><a href="/about" class="nsaa-muted text-decoration-none">About</a></li>
              <li><a href="/faq" class="nsaa-muted text-decoration-none">FAQ</a></li>
              <li><a href="/contact" class="nsaa-muted text-decoration-none">Contact</a></li>
              <li><a href="/blog" class="nsaa-muted text-decoration-none">News</a></li>
            </ul>
          </div>
          <div class="col-6 col-lg-2">
            <p class="nsaa-faint small text-uppercase mb-3">Legal</p>
            <ul class="list-unstyled d-grid gap-2 mb-0">
              <li><a href="/privacy-policy" class="nsaa-muted text-decoration-none">Privacy</a></li>
              <li><a href="/terms-of-service" class="nsaa-muted text-decoration-none">Terms</a></li>
              <li><a href="/refund-and-cancellation-policy" class="nsaa-muted text-decoration-none">Refunds</a></li>
              <li><a href="/sitemap" class="nsaa-muted text-decoration-none">All pages</a></li>
            </ul>
          </div>
          <div class="col-lg-2">
            <p class="nsaa-faint small text-uppercase mb-3">Stay updated</p>
            <form class="d-flex flex-column gap-2" data-newsletter-form>
              <input type="email" class="form-control form-control-nsaa" placeholder="you@example.com" required />
              <button class="btn btn-nsaa btn-sm" type="submit">Subscribe</button>
            </form>
          </div>
        </div>
        <div
          class="pt-4 d-flex flex-column flex-md-row justify-content-between gap-2"
          style="border-top: 1px solid var(--nsaa-border);"
        >
          <span class="nsaa-faint small">&copy; 2026 Nsaa Tickets. All rights reserved.</span>
          <span class="nsaa-faint small">Accra, Ghana</span>
        </div>
      </div>
    </footer>
  `;
}

function navLinksHtml(context, showSwitcher) {
  const parts = [
    `<a href="/" class="nsaa-nav-link">Browse</a>`,
    `<a href="/venues" class="nsaa-nav-link">Venues</a>`,
    `<a href="/organizers" class="nsaa-nav-link">Organizers</a>`,
    `<a href="/organizer-inquiry#organizer-inquiry-form" class="nsaa-nav-link nsaa-nav-link--cta">Sell tickets</a>`,
  ];

  if (context === "organizer") {
    parts.push(`<a href="/organizer-dashboard" class="nsaa-nav-link">Dashboard</a>`);
  } else {
    parts.push(`<a href="/wallet" class="nsaa-nav-link">My tickets</a>`);
  }

  if (showSwitcher) {
    parts.push(`<span class="nsaa-nav-sep" aria-hidden="true"></span>`);
    parts.push(`
      <div class="nsaa-nav-context" role="group" aria-label="Browsing context">
        <button type="button" class="nsaa-nav-link nsaa-nav-link--quiet" data-nav-context="attendee">Attending</button>
        <button type="button" class="nsaa-nav-link nsaa-nav-link--quiet" data-nav-context="organizer">Organizing</button>
      </div>
    `);
  }

  parts.push(`<div id="clerk-auth-slot"></div>`);
  return parts.join("");
}

function navShellHtml() {
  return `
    <nav class="navbar nsaa-navbar navbar-expand sticky-top">
      <div class="container">
        <a class="nsaa-brand-lockup" href="/" aria-label="Nsaa Tickets home">
          <span class="nsaa-wordmark">Nsaa</span>
          <span class="nsaa-brand-tickets" aria-label="Tickets">T I C K E T S</span>
        </a>
        <div class="ms-auto d-flex align-items-center gap-2">
          <button
            class="nsaa-nav-toggle"
            type="button"
            aria-label="Open menu"
            aria-expanded="false"
            aria-controls="nsaa-nav-links"
          >
            <i class="ph ph-list" aria-hidden="true"></i>
            <i class="ph ph-x" aria-hidden="true"></i>
          </button>
          <div class="nsaa-nav-links" id="nsaa-nav-links"></div>
        </div>
      </div>
    </nav>
  `;
}

function highlightActiveLink(linksRoot) {
  const active = activePageForNav();
  linksRoot.querySelectorAll(".nsaa-nav-link[href]").forEach((link) => {
    let linkPath = link.getAttribute("href");
    try {
      linkPath = new URL(linkPath, window.location.origin).pathname;
    } catch (_err) {
      linkPath = link.getAttribute("href");
    }
    const isActive = linkPath === active;
    link.classList.toggle("active", isActive);
    if (isActive) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });
}

function setNavContext(context, showSwitcher) {
  const linksRoot = document.getElementById("nsaa-nav-links");
  if (!linksRoot) return;

  linksRoot.innerHTML = navLinksHtml(context, showSwitcher);
  highlightActiveLink(linksRoot);
  window.dispatchEvent(new CustomEvent("nsaa:nav-rendered"));

  if (showSwitcher) {
    linksRoot.querySelectorAll("[data-nav-context]").forEach((button) => {
      const isCurrent = button.getAttribute("data-nav-context") === context;
      button.classList.toggle("active", isCurrent);
      button.addEventListener("click", () => {
        const next = button.getAttribute("data-nav-context");
        localStorage.setItem(NAV_CONTEXT_KEY, next);
        setNavContext(next, true);
        if (next === "organizer" && currentPage() !== "/organizer-dashboard") {
          window.location.href = "/organizer-dashboard";
        } else if (next === "attendee" && currentPage() === "/organizer-dashboard") {
          window.location.href = "/";
        }
      });
    });
  }
}

async function resolveClerkForChrome() {
  if (window.NSAA?.getClerk) {
    return await window.NSAA.getClerk();
  }
  if (window.NSAAClerkReady) {
    return await window.NSAAClerkReady;
  }
  if (window.Clerk) return window.Clerk;

  return await new Promise((resolve) => {
    const done = () => resolve(window.Clerk ?? null);
    window.addEventListener("nsaa:clerk-ready", done, { once: true });
    window.addEventListener("nsaa:clerk-error", () => resolve(null), { once: true });
    window.addEventListener("nsaa:clerk-unconfigured", () => resolve(null), { once: true });
    window.setTimeout(() => resolve(window.Clerk ?? null), 4000);
  });
}

async function applyRoleGating() {
  const savedContext = localStorage.getItem(NAV_CONTEXT_KEY);
  const defaultContext = currentPage() === "/organizer-dashboard" ? "organizer" : "attendee";

  try {
    const clerk = await resolveClerkForChrome();
    if (!clerk || !(clerk.user || clerk.isSignedIn)) return;

    setNavContext(savedContext || defaultContext, true);
  } catch (err) {
    console.error("Nsaa nav role check failed", err);
  }
}

function render() {
  const navMount = document.getElementById("nsaa-chrome-nav");
  if (navMount) {
    navMount.outerHTML = navShellHtml();
    setNavContext("attendee", false);
  }

  const footerMount = document.getElementById("nsaa-chrome-footer");
  if (footerMount) {
    footerMount.outerHTML = footerHtml();
  }
}

render();
applyRoleGating();
