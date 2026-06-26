/**
 * Canonical Asia/Bangkok time helpers. Bangkok is a FIXED +07:00 offset (no DST):
 * add 7h to the epoch ms then read UTC parts — never getHours()/process.env.TZ.
 * Shared by the schedule gate, the daily word counter, and the daily report.
 */
const BKK_OFFSET_MS = 7 * 3_600_000;
const p2 = (n: number): string => String(n).padStart(2, '0');

export function bangkokCalendar(ms: number): {
  date: string;
  weekday: number;
  minutesOfDay: number;
} {
  const d = new Date(ms + BKK_OFFSET_MS);
  const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const weekday = ((d.getUTCDay() + 6) % 7) + 1; // 0=Sun..6=Sat → 1=Mon..7=Sun
  const minutesOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { date, weekday, minutesOfDay };
}

export function bangkokDateString(ms: number): string {
  return bangkokCalendar(ms).date;
}

export function bangkokYear(ms: number): number {
  return new Date(ms + BKK_OFFSET_MS).getUTCFullYear();
}

export function bangkokEpochMs(date: string, minutes: number): number {
  const hh = p2(Math.floor(minutes / 60));
  const mm = p2(minutes % 60);
  return Date.parse(`${date}T${hh}:${mm}:00+07:00`);
}
