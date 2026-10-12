// _shared/daraja.ts
// Shared helpers for talking to Safaricom's Daraja API (OAuth + STK Push).
// Imported by both stk-initiate and stk-callback.
//
// CHANGES from your version:
//   - getDarajaToken() now caches the access token in memory and reuses it
//     until shortly before it expires, instead of calling /oauth/v1/generate
//     on every single stk-initiate request.

export type DarajaEnv = "sandbox" | "production";

export interface DarajaConfig {
  env: DarajaEnv;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;      // Paybill/Till (Business Short Code)
  passkey: string;        // Lipa Na M-Pesa Online Passkey, from the Daraja portal
  callbackUrl: string;    // Public URL Safaricom will POST results to (stk-callback)
}

function baseUrl(env: DarajaEnv) {
  return env === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

/**
 * Reads and validates the Daraja-related env vars in one place so a missing
 * or blank var fails loudly with a clear message instead of surfacing later
 * as an opaque "Daraja auth failed (HTTP 400)".
 */
export function loadDarajaConfig(): DarajaConfig {
  const env = (Deno.env.get("DARAJA_ENV") || "sandbox").trim() as DarajaEnv;
  const consumerKey = (Deno.env.get("DARAJA_CONSUMER_KEY") || "").trim();
  const consumerSecret = (Deno.env.get("DARAJA_CONSUMER_SECRET") || "").trim();
  const shortcode = (Deno.env.get("DARAJA_SHORTCODE") || "").trim();
  const passkey = (Deno.env.get("DARAJA_PASSKEY") || "").trim();
  const callbackUrl = (Deno.env.get("DARAJA_CALLBACK_URL") || "").trim();

  const missing = Object.entries({
    DARAJA_CONSUMER_KEY: consumerKey,
    DARAJA_CONSUMER_SECRET: consumerSecret,
    DARAJA_SHORTCODE: shortcode,
    DARAJA_PASSKEY: passkey,
    DARAJA_CALLBACK_URL: callbackUrl,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    throw new Error(
      `Missing Daraja env var(s): ${missing.join(", ")}. Set these with ` +
        `"supabase secrets set" (see README).`,
    );
  }
  if (env !== "sandbox" && env !== "production") {
    throw new Error(`DARAJA_ENV must be "sandbox" or "production", got "${env}".`);
  }

  return { env, consumerKey, consumerSecret, shortcode, passkey, callbackUrl };
}

// ---- Token cache -----------------------------------------------------
// Module-level state persists for the life of a warm Deno isolate, so
// back-to-back requests handled by the same isolate skip the OAuth call
// entirely. This is a best-effort optimization, not a guarantee:
//   - Supabase/Deno Deploy can spin up multiple isolates under load, each
//     with its own empty cache, so you'll still see occasional fresh
//     token fetches even while "cached".
//   - A cold start (first request after idle) always fetches fresh.
//   - Nothing here is shared across isolates (no KV/Redis) — that would
//     be the next step up if you want a harder guarantee, but for STK
//     push traffic this in-memory cache removes the vast majority of the
//     redundant round-trips.
interface CachedToken {
  token: string;
  expiresAt: number; // ms epoch
}
const tokenCache = new Map<string, CachedToken>();
// Refresh this many seconds before Daraja's stated expiry, so a token
// already "in flight" toward another fetch never gets used past its
// real expiry (Daraja tokens are normally valid ~3599s).
const TOKEN_REFRESH_MARGIN_SEC = 60;

/**
 * Fetches a Daraja OAuth access token, reusing a cached one if it's still
 * fresh. This is the call that a sandbox/production key mismatch, a bad
 * Base64 header, or stale credentials will make fail with 400/401/403 —
 * the "Daraja auth failed" error in the UI comes from here.
 */
export async function getDarajaToken(cfg: DarajaConfig): Promise<string> {
  const cacheKey = `${cfg.env}:${cfg.consumerKey}`;
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.token;
  }

  const url = `${baseUrl(cfg.env)}/oauth/v1/generate?grant_type=client_credentials`;
  // btoa is fine here: consumer key/secret are ASCII.
  const basic = btoa(`${cfg.consumerKey}:${cfg.consumerSecret}`);

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Basic ${basic}` },
  });

  const text = await res.text();
  if (!res.ok) {
    // Surface Daraja's actual error body — it usually says exactly what's
    // wrong (invalid credentials, app not subscribed to product, etc).
    throw new Error(`Daraja auth failed (HTTP ${res.status}): ${text}`);
  }

  let data: { access_token?: string; expires_in?: string | number };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Daraja auth returned non-JSON body: ${text}`);
  }
  if (!data.access_token) {
    throw new Error(`Daraja auth response missing access_token: ${text}`);
  }

  const expiresInSec = Number(data.expires_in);
  const safeExpiresInSec = Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 3600;
  const expiresAt = now + Math.max(0, safeExpiresInSec - TOKEN_REFRESH_MARGIN_SEC) * 1000;

  tokenCache.set(cacheKey, { token: data.access_token, expiresAt });

  return data.access_token;
}

function darajaTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/** Normalizes 07xxxxxxxx / +2547xxxxxxxx / 2547xxxxxxxx / 01xxxxxxxx to 2547xxxxxxxx / 2541xxxxxxxx */
export function normalizeKenyanPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return "254" + digits.slice(1);
  if ((digits.startsWith("7") || digits.startsWith("1")) && digits.length === 9) {
    return "254" + digits;
  }
  throw new Error(`Could not normalize phone number: ${raw}`);
}

export interface StkPushResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  responseCode: string;
  responseDescription: string;
  customerMessage: string;
}

/**
 * Initiates an STK Push ("Lipa Na M-Pesa Online") prompt to the customer's
 * phone. accountReference and transactionDesc must each be <= 12/13 chars
 * for some shortcodes — keep them short.
 */
export async function initiateStkPush(
  cfg: DarajaConfig,
  token: string,
  opts: { phone: string; amount: number; accountReference: string; transactionDesc: string },
): Promise<StkPushResult> {
  const timestamp = darajaTimestamp();
  const password = btoa(`${cfg.shortcode}${cfg.passkey}${timestamp}`);
  // opts.phone is expected to already be normalized by the caller (see
  // stk-initiate) — normalizeKenyanPhone is idempotent on an already-
  // normalized number, so calling it again here is a harmless safety net.
  const phone = normalizeKenyanPhone(opts.phone);

  const res = await fetch(`${baseUrl(cfg.env)}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      BusinessShortCode: cfg.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(opts.amount),
      PartyA: phone,
      PartyB: cfg.shortcode,
      PhoneNumber: phone,
      CallBackURL: cfg.callbackUrl,
      AccountReference: opts.accountReference.slice(0, 12),
      TransactionDesc: opts.transactionDesc.slice(0, 13),
    }),
  });

  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`STK push returned non-JSON body (HTTP ${res.status}): ${text}`);
  }

  if (!res.ok || data.ResponseCode !== "0") {
    const desc = (data.errorMessage as string) || (data.ResponseDescription as string) || text;
    throw new Error(`STK push rejected (HTTP ${res.status}): ${desc}`);
  }

  return {
    merchantRequestId: data.MerchantRequestID as string,
    checkoutRequestId: data.CheckoutRequestID as string,
    responseCode: data.ResponseCode as string,
    responseDescription: data.ResponseDescription as string,
    customerMessage: data.CustomerMessage as string,
  };
}
