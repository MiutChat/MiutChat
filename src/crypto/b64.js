'use strict';
/**
 * Base64 encode/decode, native-API-first with the original manual-loop
 * fallback for browsers that don't have it yet (not universal as of this
 * writing — see caniuse "mdn-javascript_builtins_uint8array_tobase64").
 *
 * Why not WASM: these are byte-for-byte the same operation browsers
 * already expose natively via Uint8Array.prototype.toBase64/fromBase64/
 * setFromBase64 (Baseline 2025). A WASM module would add bundle size and
 * a load/compile step to do the exact same work the engine already does
 * in native code — no win. (And for the app's actual crypto — AES-GCM via
 * crypto.subtle — WASM measurably loses to Web Crypto's hardware-
 * accelerated implementation for payloads this size; see the research
 * notes in crypto-engine.js above _b64Fast. Base64 framing, not
 * encryption itself, was the real hot loop worth touching.)
 */

// Encodes a byte buffer to a plain-alphabet base64 string.
export function encodeB64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

// Decodes a base64 string (plain or URL-safe — both normalized first, as
// the original call sites did) into a new Uint8Array.
export function decodeB64(str) {
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(normalized);
  return Uint8Array.from(atob(normalized), c => c.charCodeAt(0));
}

// Decodes `str` directly into `dest` (no normalization — callers that
// need URL-safe handling should normalize first, same as decodeB64).
// Returns the number of bytes written, so callers tracking an output
// offset across multiple chunks can advance it correctly either way.
export function decodeB64Into(dest, str) {
  if (typeof dest.setFromBase64 === 'function') {
    return dest.setFromBase64(str).written;
  }
  const bin = atob(str);
  for (let n = 0; n < bin.length; n++) dest[n] = bin.charCodeAt(n);
  return bin.length;
}
