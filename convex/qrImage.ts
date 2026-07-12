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
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
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

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

function pdfText(value: string | undefined, fallback = ""): string {
  const text = String(value ?? fallback).trim() || fallback;
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "?");
}

function formatEventDate(startsAt?: number): string {
  if (!startsAt) return "Date TBA";
  return new Intl.DateTimeFormat("en-GH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Accra",
  }).format(new Date(startsAt));
}

function wrapText(text: string, font: any, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);

    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
      continue;
    }

    let chunk = "";
    for (const char of word) {
      const next = `${chunk}${char}`;
      if (font.widthOfTextAtSize(next, size) <= maxWidth) {
        chunk = next;
      } else {
        if (chunk) lines.push(chunk);
        chunk = char;
      }
    }
    current = chunk;
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function drawCenteredText(page: any, text: string, font: any, size: number, y: number, color: any) {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: (PAGE_WIDTH - width) / 2,
    y,
    size,
    font,
    color,
  });
}

export const ticketsToPdfBase64 = internalAction({
  args: {
    eventTitle: v.string(),
    venue: v.string(),
    startsAt: v.optional(v.number()),
    ticketTypeName: v.string(),
    tickets: v.array(
      v.object({
        qrToken: v.string(),
        ownerName: v.string(),
        ticketId: v.string(),
        index: v.number(),
      }),
    ),
  },
  handler: async (_ctx, args) => {
    const pdfDoc = await PDFDocument.create();
    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const ink = rgb(0.07, 0.06, 0.04);
    const muted = rgb(0.42, 0.42, 0.45);
    const rule = rgb(0.86, 0.82, 0.73);
    const paper = rgb(0.97, 0.95, 0.9);
    const gold = rgb(0.87, 0.7, 0.42);
    const eventTitle = pdfText(args.eventTitle, "Nsaa Tickets event");
    const venue = pdfText(args.venue, "Venue TBA");
    const ticketTypeName = pdfText(args.ticketTypeName, "Ticket");
    const eventDate = pdfText(formatEventDate(args.startsAt));
    const total = args.tickets.length;

    for (const ticket of args.tickets) {
      const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      const ownerName = pdfText(ticket.ownerName, "Ticket holder");
      const label = total > 1 ? `Ticket ${ticket.index + 1} of ${total}` : "Ticket";
      const shortId = pdfText(ticket.ticketId.slice(-8).toUpperCase());

      page.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, color: paper });
      page.drawRectangle({
        x: 48,
        y: 48,
        width: 516,
        height: 696,
        color: rgb(1, 1, 1),
        borderColor: rule,
        borderWidth: 1,
      });
      page.drawRectangle({ x: 48, y: 686, width: 516, height: 58, color: gold });
      page.drawRectangle({ x: 72, y: 701, width: 34, height: 34, color: ink });
      page.drawText("N", { x: 83, y: 710, size: 17, font: bold, color: gold });
      page.drawText("NSAA", { x: 118, y: 716, size: 18, font: bold, color: ink });
      page.drawText("TICKETS", { x: 118, y: 704, size: 8, font: bold, color: ink });
      page.drawText(label.toUpperCase(), { x: 438, y: 708, size: 10, font: bold, color: ink });

      const titleLines = wrapText(eventTitle, bold, 24, 430).slice(0, 2);
      let y = 634;
      for (const line of titleLines) {
        drawCenteredText(page, line, bold, 24, y, ink);
        y -= 30;
      }

      drawCenteredText(page, ticketTypeName.toUpperCase(), bold, 10, y - 4, muted);
      page.drawLine({ start: { x: 96, y: y - 22 }, end: { x: 516, y: y - 22 }, thickness: 1, color: rule });

      const qrBuffer: Buffer = await QRCode.toBuffer(ticket.qrToken, { margin: 1, width: 720 });
      const qrImage = await pdfDoc.embedPng(qrBuffer);
      page.drawRectangle({
        x: 176,
        y: 302,
        width: 260,
        height: 260,
        borderColor: rule,
        borderWidth: 1,
        color: rgb(1, 1, 1),
      });
      page.drawImage(qrImage, { x: 190, y: 316, width: 232, height: 232 });

      page.drawText("ADMIT", { x: 96, y: 274, size: 8, font: bold, color: muted });
      page.drawText(ownerName, { x: 96, y: 250, size: 18, font: bold, color: ink });
      page.drawText("EVENT DATE", { x: 96, y: 214, size: 8, font: bold, color: muted });
      page.drawText(eventDate, { x: 96, y: 195, size: 12, font: regular, color: ink });
      page.drawText("VENUE", { x: 320, y: 214, size: 8, font: bold, color: muted });
      page.drawText(wrapText(venue, regular, 12, 190)[0], { x: 320, y: 195, size: 12, font: regular, color: ink });

      page.drawLine({ start: { x: 96, y: 158 }, end: { x: 516, y: 158 }, thickness: 1, color: rule });
      drawCenteredText(page, "Scan once at entry. Print this page or show it on your phone.", regular, 10, 132, muted);
      drawCenteredText(page, `Ticket ID: ${shortId}`, regular, 9, 112, muted);
      drawCenteredText(page, "nsaatickets.com", bold, 10, 78, ink);
    }

    const bytes = await pdfDoc.save();
    return Buffer.from(bytes).toString("base64");
  },
});
