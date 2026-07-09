// Shared Brevo sending helper. Every outbound transactional email in this
// project goes through here so sender identities stay centralized and a
// failure never throws back into the caller's mutation/action.

export function escapeHtml(value: string): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// One identity per functional role, all on the nsaatickets.com domain.
// Keep "Nsaa Tickets" as the recognizable core name; only add a role
// suffix where it helps the recipient tell threads apart.
export const SENDERS = {
  tickets: { name: "Nsaa Tickets", email: "tickets@nsaatickets.com" },
  support: { name: "Nsaa Tickets Support", email: "support@nsaatickets.com" },
  events: { name: "Nsaa Tickets Events", email: "events@nsaatickets.com" },
  hello: { name: "Nsaa Tickets", email: "hello@nsaatickets.com" },
} as const;

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function paragraph(html: string): string {
  return `<p style="margin:0 0 14px; font-size:15px; line-height:1.6; color:#33333a;">${html}</p>`;
}

// Wraps email body content in a branded "paper ledger" letterhead: white
// card, gold header band, dashed divider, muted footer. Mirrors the QR
// ticket shell's sanctioned white/printed-object exception (see
// DESIGN.md) rather than the site's dark chrome, since full dark-bg HTML
// emails get unpredictably color-inverted by Gmail/Outlook/Apple Mail
// dark-mode rewriting. Logo/colors are placeholders pending final brand
// assets - swap the hex values below when those land.
export function renderEmailLayout(params: {
  heading: string;
  bodyHtml: string;
  footerNote?: string;
}): string {
  const { heading, bodyHtml, footerNote } = params;
  return `<!doctype html>
<html lang="en">
  <body style="margin:0; padding:0; background-color:#f2efe8; font-family:${FONT_STACK};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2efe8; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; background-color:#ffffff; border:1px solid #e8e3d8;">
            <tr>
              <td style="background-color:#dfb36c; padding:22px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="width:34px; height:34px; background-color:#120e06; text-align:center; vertical-align:middle; font-weight:800; font-size:15px; color:#dfb36c;">N</td>
                    <td style="padding-left:12px;">
                      <div style="font-weight:800; font-size:19px; letter-spacing:-0.02em; color:#120e06; line-height:1;">NSAA</div>
                      <div style="font-weight:700; font-size:10px; letter-spacing:0.22em; color:#120e06; line-height:1; margin-top:3px;">TICKETS</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px; font-weight:800; font-size:20px; letter-spacing:-0.01em; color:#0b0b0e;">${heading}</h1>
                <div style="font-size:15px; line-height:1.6; color:#33333a;">${bodyHtml}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px;"><div style="border-top:1px dashed #d8d2c2;"></div></td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px;">
                <p style="margin:0; font-size:12px; line-height:1.6; color:#9a9a9f;">${footerNote ?? "Nsaa Tickets &middot; Accra, Ghana"}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function sendBrevoEmail(params: {
  sender: { name: string; email: string };
  to: { email: string; name?: string }[];
  subject: string;
  htmlContent: string;
}): Promise<void> {
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.BREVO_API_KEY ?? "",
      },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      console.error(`Brevo email failed: ${response.status} ${await response.text()}`);
    }
  } catch (err) {
    console.error("Brevo email failed", err);
  }
}
