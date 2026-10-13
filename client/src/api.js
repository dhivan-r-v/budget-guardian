export async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { status: res.status, body });
  return body;
}

export const usd = (cents) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Whole dollars for axis ticks.
export const usdShort = (cents) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthShort = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1];
export const monthLong = (ym) => `${MONTHS_LONG[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
export const dateLong = (ymd) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}, ${ymd.slice(0, 4)}`;

export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export const STATUS_TEXT = {
  approved: 'Approved, sending…',
  sent: 'Sent to PayPal',
  completed: 'Moved to savings',
  failed: 'Failed',
};
