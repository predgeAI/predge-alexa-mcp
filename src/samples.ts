/** Demo-only data. Generic merchants, no third-party brands. Every confirmation below is a SAMPLE written for this demo, not real merchant output. */
export type Kind = "tickets" | "cleaning" | "album";

export const SAMPLE_PURCHASES: Record<Kind, { merchant: string; item: string; amount_usd: number; promised: string[]; due_by: string; match: RegExp }> = {
  tickets: { merchant: "a ticketing service", item: "two tickets, Saturday 7pm show", amount_usd: 32, promised: ["ticket_id", "seat", "showtime"], due_by: "Saturday 5pm", match: /ticket|show|movie|concert/i },
  cleaning: { merchant: "a home-cleaning service", item: "2-hour home cleaning, Thursday 10am", amount_usd: 85, promised: ["booking_id", "cleaner", "arrival_window"], due_by: "Wednesday", match: /clean/i },
  album: { merchant: "a photo-album service", item: "digital photo album", amount_usd: 12, promised: ["order_id", "download_url"], due_by: "today", match: /album|photo/i },
};

/** Sample merchant confirmations. "broken" variants leave out one promised detail. */
export const SAMPLE_CONFIRMATIONS: Record<Kind, { ok: Record<string, unknown>; broken: Record<string, unknown> }> = {
  tickets: {
    ok: { status: "confirmed", ticket_id: "SAMPLE-48213", seat: "Row F, seats 7-8", showtime: "Sat 19:00" },
    broken: { status: "confirmed", ticket_id: "SAMPLE-48213", showtime: "Sat 19:00" },
  },
  cleaning: {
    ok: { status: "confirmed", booking_id: "SAMPLE-7731", cleaner: "Maria K.", arrival_window: "10:00-10:30" },
    broken: { status: "confirmed", booking_id: "SAMPLE-7731", cleaner: "Maria K." },
  },
  album: {
    ok: { status: "confirmed", order_id: "SAMPLE-2209", download_url: "https://albums.example/dl/SAMPLE-2209" },
    broken: { status: "confirmed", order_id: "SAMPLE-2209" },
  },
};

export const kindOf = (text: string): Kind | undefined => (Object.keys(SAMPLE_PURCHASES) as Kind[]).find((k) => SAMPLE_PURCHASES[k].match.test(text));
