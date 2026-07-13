// Mounts Clerk's sign-in button or user avatar into the #clerk-auth-slot
// element present in every page's navbar. Clerk is loaded by clerk-loader.js.
//
// This intentionally does NOT gate attendee checkout behind auth - guest
// checkout stays available. The tradeoff is explicit in the UI: an account
// is what links current and previous tickets into the wallet. Organizers
// still use the separate mandatory /organizer-signup flow.

async function resolveClerk() {
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

async function mountClerkNav() {
  const slot = document.getElementById("clerk-auth-slot");
  if (!slot) return;
  slot.innerHTML = `<span class="nsaa-auth-loading" aria-label="Loading account"></span>`;

  try {
    const clerk = await resolveClerk();

    if (!clerk) {
      slot.innerHTML = "";
      return;
    }

    slot.innerHTML = "";

    if (clerk.user || clerk.isSignedIn) {
      clerk.mountUserButton(slot);
    } else {
      const here = window.location.pathname + window.location.search;

      const signInLink = document.createElement("a");
      signInLink.className = "btn btn-sm btn-outline-nsaa";
      signInLink.textContent = "Sign in";
      signInLink.href = `/signin?redirect_url=${encodeURIComponent(here)}`;

      const signUpLink = document.createElement("a");
      signUpLink.className = "btn btn-sm btn-nsaa";
      signUpLink.textContent = "Sign up";
      signUpLink.href = `/signup?redirect_url=${encodeURIComponent(here)}`;

      slot.appendChild(signInLink);
      slot.appendChild(signUpLink);
    }
  } catch (err) {
    console.error("Clerk failed to load", err);
    slot.innerHTML = "";
  }
}

window.NSAAMountClerkNav = mountClerkNav;
window.addEventListener("nsaa:nav-rendered", mountClerkNav);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountClerkNav, { once: true });
} else {
  mountClerkNav();
}
