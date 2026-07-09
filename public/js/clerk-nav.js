// Mounts Clerk's sign-in button or user avatar into the #clerk-auth-slot
// element present in every page's navbar. Loaded after the Clerk script
// tag (data-clerk-publishable-key) has already been injected in <head>.
//
// This intentionally does NOT gate any page or action behind auth - per
// the product decision that guest checkout is the default. Signing in
// only unlocks "see all your past tickets in one place" convenience,
// nothing else currently depends on it.

window.addEventListener("load", async () => {
  const slot = document.getElementById("clerk-auth-slot");
  if (!slot || !window.Clerk) return;

  try {
    await window.Clerk.load();

    if (window.Clerk.user) {
      window.Clerk.mountUserButton(slot);
    } else {
      const signInBtn = document.createElement("button");
      signInBtn.className = "btn btn-sm btn-nsaa";
      signInBtn.textContent = "Sign in";
      signInBtn.addEventListener("click", () => window.Clerk.openSignIn());
      slot.appendChild(signInBtn);
    }
  } catch (err) {
    console.error("Clerk failed to load", err);
  }
});
