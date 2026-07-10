// Mounts Clerk's sign-in button or user avatar into the #clerk-auth-slot
// element present in every page's navbar. Clerk is loaded by clerk-loader.js.
//
// This intentionally does NOT gate any page or action behind auth - per
// the product decision that guest checkout is the default. Signing in
// only unlocks "see all your past tickets in one place" convenience,
// nothing else currently depends on it.

window.addEventListener("load", async () => {
  const slot = document.getElementById("clerk-auth-slot");
  if (!slot) return;

  try {
    const clerk = window.NSAA?.getClerk
      ? await window.NSAA.getClerk()
      : await (window.NSAAClerkReady ?? Promise.resolve(window.Clerk));

    if (!clerk) return;

    if (clerk.user || clerk.isSignedIn) {
      clerk.mountUserButton(slot);
    } else {
      const signInLink = document.createElement("a");
      signInLink.className = "btn btn-sm btn-nsaa";
      signInLink.textContent = "Sign in";
      const here = window.location.pathname + window.location.search;
      signInLink.href = `/signin?redirect_url=${encodeURIComponent(here)}`;
      slot.appendChild(signInLink);
    }
  } catch (err) {
    console.error("Clerk failed to load", err);
  }
});
