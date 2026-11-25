export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const totalTenths = Math.round(Math.max(0, ms) / 100);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  const secondsText = String(seconds).padStart(2, '0') + '.' + tenths;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${secondsText}`;
  return `${minutes}:${secondsText}`;
}

export function formatRate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}
