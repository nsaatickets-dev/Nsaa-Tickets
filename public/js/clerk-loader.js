(function () {
  const config = window.NSAA_CLERK_CONFIG ?? {};
  const publishableKey = String(config.publishableKey ?? "").trim();
  const frontendApiUrl = String(config.frontendApiUrl ?? "").trim();
  const applicationName = String(config.applicationName ?? "Nsaa Tickets").trim() || "Nsaa Tickets";

  const localization = {
    signIn: {
      alternativePhoneCodeProvider: {
        title: `Sign in to ${applicationName}`,
      },
      emailCode: {
        subtitle: `to continue to ${applicationName}`,
      },
      emailCodeMfa: {
        subtitle: `to continue to ${applicationName}`,
      },
      emailLink: {
        subtitle: `to continue to ${applicationName}`,
      },
      emailLinkMfa: {
        subtitle: `to continue to ${applicationName}`,
      },
      start: {
        title: `Sign in to ${applicationName}`,
        titleCombined: `Continue to ${applicationName}`,
      },
    },
    signUp: {
      alternativePhoneCodeProvider: {
        title: `Sign up to ${applicationName}`,
      },
      emailLink: {
        subtitle: `to continue to ${applicationName}`,
      },
    },
  };

  function normalizeFrontendApiUrl(value) {
    return value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }

  function isConfigured() {
    return (
      publishableKey &&
      frontendApiUrl &&
      !publishableKey.includes("REPLACE_ME") &&
      !frontendApiUrl.includes("REPLACE_ME")
    );
  }

  function loadScript(src, attributes = {}) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.defer = true;
      script.crossOrigin = "anonymous";
      script.src = src;

      Object.entries(attributes).forEach(([key, value]) => {
        script.setAttribute(key, value);
      });

      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  window.NSAAClerkReady = (async () => {
    if (!isConfigured()) {
      window.dispatchEvent(new CustomEvent("nsaa:clerk-unconfigured"));
      return null;
    }

    const clerkDomain = normalizeFrontendApiUrl(frontendApiUrl);

    await loadScript(`https://${clerkDomain}/npm/@clerk/ui@1/dist/ui.browser.js`);
    await loadScript(
      `https://${clerkDomain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`,
      {
        "data-clerk-publishable-key": publishableKey,
      },
    );

    if (!window.Clerk) {
      throw new Error("ClerkJS loaded but window.Clerk is unavailable");
    }

    await window.Clerk.load({
      localization,
      ui: { ClerkUI: window.__internal_ClerkUICtor },
    });

    window.dispatchEvent(new CustomEvent("nsaa:clerk-ready"));
    return window.Clerk;
  })().catch((err) => {
    console.error("Clerk failed to initialize", err);
    window.dispatchEvent(new CustomEvent("nsaa:clerk-error", { detail: err }));
    return null;
  });
})();
