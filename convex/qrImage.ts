"use node";

// Server-side QR PNG generation, served via the HTTP route in
// convex/http.ts (GET /tickets/qr?ticketId=...) rather than embedded as
// inline base64 in emails - Gmail strips inline data: image URIs from
// HTML email (unlike Apple Mail, which renders them fine), so a real
// fetchable image URL is the only approach that works everywhere.
// Isolated into its own file because it needs the Node runtime
// (qrcode's PNG encoder uses Node's Buffer/zlib) - keeping "use node"
// out of convex/moolre.ts and convex/http.ts avoids slower cold starts
// for the webhook-triggered functions that live there.

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import QRCode from "qrcode";

// Returns base64 (not raw bytes) - Convex's action-to-action value
// serialization doesn't reliably carry ArrayBuffer/Uint8Array, and this
// file's caller (convex/http.ts) doesn't run in the Node runtime, so it
// can't use Buffer to decode either way - it decodes this base64 string
// via the standard Web atob() API instead.
export const tokenToPngBase64 = internalAction({
  args: { token: v.string() },
  handler: async (_ctx, { token }) => {
    const buffer: Buffer = await QRCode.toBuffer(token, { margin: 1, width: 480 });
    return buffer.toString("base64");
  },
});
