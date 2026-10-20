// Pure, deterministic order sizing and confirmation logic. No network calls.
// Treat exchange quantities as base-asset units, never as USD notional.
function positiveNumber(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid " + label);
  return n;
}

export function planSpotSellQuantity({available, requested = null, precision}) {
  const balance = positiveNumber(available, "available spot balance");
  if (!Number.isInteger(precision) || precision < 0 || precision > 12)
    throw new Error("Invalid exchange quantity precision");
  const requestedQty = requested == null ? balance : positiveNumber(requested, "requested sell quantity");
  // Do not turn a partial sale into a full-balance sale, even when the caller is
  // holding other strategy positions in the same asset.
  const unit = 10 ** precision;
  const balanceUnits = Math.floor(balance * unit + 1e-7);
  const requestedUnits = Math.floor(requestedQty * unit + 1e-7);
  if (requested != null && requestedQty > balance + (0.01 / unit))
    throw new Error("Requested sell exceeds available spot balance");
  const units = Math.min(balanceUnits, requestedUnits);
  if (units <= 0) throw new Error("Sell size below exchange quantity precision");
  return {size: (units / unit).toFixed(precision), quantity: units / unit, requestedQty, availableQty: balance};
}

export function confirmSpotSellFill({status, confirmedQty, requestedQty, precision}) {
  if (!Number.isInteger(precision) || precision < 0 || precision > 12)
    return false;
  if (!["filled", "full_fill"].includes(String(status || "").toLowerCase())) return false;
  if (![confirmedQty, requestedQty].every(v => typeof v === "number" && Number.isFinite(v) && v > 0)) return false;
  const tolerance = 0.51 / (10 ** precision);
  return confirmedQty >= requestedQty - tolerance && confirmedQty <= requestedQty + tolerance;
}

export function confirmZeroFillCancellation({status, confirmedQty}) {
  return ["cancelled", "cancel"].includes(String(status || "").toLowerCase()) &&
    typeof confirmedQty === "number" && Number.isFinite(confirmedQty) && confirmedQty === 0;
}
