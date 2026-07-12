const MOOLRE_LIVE_API_BASE = "https://api.moolre.com";

export function requireMoolreLiveApiBase(): string {
  const apiBase = process.env.MOOLRE_API_BASE?.trim().replace(/\/+$/, "");

  if (!apiBase) {
    throw new Error("MOOLRE_API_BASE is not configured.");
  }

  if (apiBase !== MOOLRE_LIVE_API_BASE) {
    throw new Error(
      `Production checkout only allows ${MOOLRE_LIVE_API_BASE}. Update MOOLRE_API_BASE before taking payments.`,
    );
  }

  return apiBase;
}

export function requireMoolreEnv(required: string[]): Record<string, string> {
  const values: Record<string, string> = {
    MOOLRE_API_BASE: requireMoolreLiveApiBase(),
  };
  const missing: string[] = [];

  for (const name of required) {
    if (name === "MOOLRE_API_BASE") continue;
    const value = process.env[name]?.trim();
    if (!value) {
      missing.push(name);
    } else {
      values[name] = value;
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Moolre live API is not fully configured. Missing: ${missing.join(", ")}.`,
    );
  }

  return values;
}
