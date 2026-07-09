// Shared server-side input validation. Client-side checks (nsaa.js) are
// for UX only - they can be bypassed by anyone calling the Convex API
// directly, so every mutation that accepts free-text input validates it
// again here before it touches the database.

export function requireNonEmpty(value: string, field: string, maxLength = 200): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required.`);
  if (trimmed.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

export function optionalTrimmed(
  value: string | undefined,
  maxLength = 200,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new Error(`Value must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

export function requireValidEmail(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || trimmed.length > 254) {
    throw new Error("A valid email address is required.");
  }
  return trimmed;
}

// Mirrors NSAA.isValidGhanaPhone in public/js/nsaa.js - kept as a
// separate server-side copy on purpose, since the client-side version is
// UX-only and must not be trusted as the real check.
export function requireValidGhanaPhone(value: string): string {
  const clean = value.replace(/[\s\-+()]/g, "");
  const isValid = /^233\d{9}$/.test(clean) || /^0\d{9}$/.test(clean);
  if (!isValid) {
    throw new Error("A valid Ghanaian phone number is required.");
  }
  return value.trim();
}

export function requirePositiveNumber(value: number, field: string, max = 1_000_000): number {
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`${field} must be a valid number between 0 and ${max}.`);
  }
  return value;
}

export function requirePositiveInteger(value: number, field: string, max = 100_000): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${field} must be a whole number between 1 and ${max}.`);
  }
  return value;
}
