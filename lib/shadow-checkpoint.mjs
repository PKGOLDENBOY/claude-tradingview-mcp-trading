/**
 * Durable, exchange-independent state for the public-GET-only AlphaBot shadow.
 * Atomic snapshots persist across Railway restarts; no credentials or orders.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

export const SHADOW_STATE_VERSION = 1;
export const SHADOW_MODE = "PUBLIC_MARKET_READ_ONLY_SHADOW";

export function loadShadowCheckpoint(path) {
  if (!existsSync(path)) return null; // first run on a fresh dedicated volume
  let state;
  try { state = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new Error("SHADOW_CHECKPOINT_CORRUPT: " + e.message); }
  if (state?.schemaVersion !== SHADOW_STATE_VERSION || state?.safetyMode !== SHADOW_MODE ||
      !Number.isSafeInteger(state.startedAt) || !Number.isSafeInteger(state.endsAt) ||
      state.endsAt <= state.startedAt || !state?.positions || !state?.summary ||
      !Number.isSafeInteger(state.cycles) || state.cycles < 0) {
    throw new Error("SHADOW_CHECKPOINT_INVALID: refusing to discard prior shadow evidence");
  }
  return state;
}

export function saveShadowCheckpoint(path, state) {
  if (!path || typeof path !== "string") throw new TypeError("Shadow checkpoint path required");
  const record = { ...state, schemaVersion:SHADOW_STATE_VERSION, safetyMode:SHADOW_MODE };
  const serialized = JSON.stringify(record) + "\n";
  mkdirSync(dirname(path), { recursive:true });
  const temp = path + ".tmp";
  writeFileSync(temp, serialized, { encoding:"utf8", mode:0o600 });
  renameSync(temp, path);
}

export function appendShadowEvidence(path, event) {
  if (!path || typeof path !== "string") throw new TypeError("Shadow events path required");
  if (!["SHADOW_ENTRY", "SHADOW_EXIT"].includes(event?.tag))
    throw new Error("SHADOW_EVENT_NOT_A_TRADE: only completed synthetic entry/exit evidence allowed");
  if (event.safety !== SHADOW_MODE) throw new Error("SHADOW_EVENT_UNSAFE_MODE");
  mkdirSync(dirname(path), { recursive:true });
  appendFileSync(path, JSON.stringify(event) + "\n", {encoding:"utf8",mode:0o600});
}
