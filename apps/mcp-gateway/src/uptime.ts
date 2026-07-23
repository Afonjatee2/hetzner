/**
 * formatUptime – render a duration in whole seconds as a human-readable string.
 *
 * Examples:
 *   formatUptime(0)      → "0s"
 *   formatUptime(90)     → "1m 30s"
 *   formatUptime(3661)   → "1h 1m 1s"
 *   formatUptime(90061)  → "1d 1h 1m 1s"
 *
 * Fractional input is truncated to whole seconds before formatting.
 * Leading zero-valued units are omitted; the minimum output is "0s".
 */
export function formatUptime(seconds: number): string {
  const total = Math.floor(seconds);

  if (total <= 0) return "0s";

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0) parts.push(`${secs}s`);

  return parts.length > 0 ? parts.join(" ") : "0s";
}
