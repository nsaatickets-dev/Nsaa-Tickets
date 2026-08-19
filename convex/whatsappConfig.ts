// Meta's Graph API base for the WhatsApp Cloud API. Pinned to a specific
// stable version (not env-configurable) - same spirit as
// moolreConfig.ts's hard-pinned live API base, just with no swappable
// sandbox/live distinction to guard against here.
export const WHATSAPP_GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

export function requireWhatsAppEnv(required: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of required) {
    const value = process.env[name]?.trim();
    if (!value) {
      missing.push(name);
    } else {
      values[name] = value;
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `WhatsApp integration is not fully configured. Missing: ${missing.join(", ")}.`,
    );
  }

  return values;
}
