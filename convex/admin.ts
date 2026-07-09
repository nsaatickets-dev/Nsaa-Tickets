// Minimal admin gate for the handful of functions that move money or set
// revenue rates (organizer payouts, tier overrides) and have no self-serve
// UI yet. Convex public functions are callable by anyone who knows the
// deployment URL and function name - "no UI exposes this" is not access
// control - so these require a shared secret until a real admin-role
// system exists (see README "Known gaps").
export function requireAdminSecret(providedSecret: string | undefined) {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    throw new Error(
      "ADMIN_SECRET is not configured on this deployment - set one with `npx convex env set ADMIN_SECRET $(openssl rand -hex 32)` before calling admin functions.",
    );
  }
  if (providedSecret !== expected) {
    throw new Error("Invalid admin secret.");
  }
}
