import { sendBrevoEmail, SENDERS, escapeHtml } from "./email";

// Deliberately narrow: only for infrastructure/system failures where we
// LOSE VISIBILITY into something that moves money (e.g. can't reach
// Moolre's status endpoint at all) - never for routine, expected
// business outcomes (a declined card, a wrong OTP, a rate limit hit).
// Those are frequent and normal; alerting on them would just teach
// whoever reads these to ignore them.
export async function alertCritical(subject: string, details: string): Promise<void> {
  console.error(`[CRITICAL] ${subject}: ${details}`);

  const alertEmail = process.env.ALERT_EMAIL || "support@nsaatickets.com";
  try {
    await sendBrevoEmail({
      sender: SENDERS.support,
      to: [{ email: alertEmail }],
      subject: `[Nsaa Alert] ${subject}`,
      htmlContent: `<p style="font-family:sans-serif; font-size:14px;">${escapeHtml(details)}</p>`,
    });
  } catch (err) {
    // If Brevo itself is down, there's no reliable out-of-band channel
    // left - this falls back to the console.error above, visible via
    // `npx convex logs` or the Convex dashboard's Logs tab.
    console.error("Alert email itself failed to send", err);
  }
}
