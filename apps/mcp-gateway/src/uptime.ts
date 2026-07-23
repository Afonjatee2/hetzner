const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

export function formatUptime(seconds: number): string {
  const roundedSeconds = Math.round(seconds);
  const days = Math.floor(roundedSeconds / SECONDS_PER_DAY);
  const hours = Math.floor((roundedSeconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
  const minutes = Math.floor((roundedSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const remainingSeconds = roundedSeconds % SECONDS_PER_MINUTE;
  const parts: string[] = [];

  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${remainingSeconds}s`);

  return parts.join(" ");
}
