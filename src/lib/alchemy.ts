import { createHmac } from 'node:crypto';
import { config } from '../config.ts';

/**
 * Returns the path + alphabetically-sorted query string for a full URL.
 *
 * Literal port of Alchemy's reference `getPath()` from
 * https://alchemypay.readme.io/docs/api-sign — we keep the same shape so any
 * server-side reconstruction matches what we sign.
 */
function getPath(requestUrl: string): string {
  const uri = new URL(requestUrl);
  const path = uri.pathname;
  const params = Array.from(uri.searchParams.entries());
  if (params.length === 0) return path;
  const sorted = [...params].sort(([a], [b]) => a.localeCompare(b));
  return `${path}?${sorted.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

/**
 * Returns the body string that goes into the HMAC input. Empty string for
 * GET (no body) and empty objects; otherwise the body's keys are sorted
 * alphabetically and re-stringified.
 *
 * Key-sorting matters: Alchemy's reference signing code sorts the body
 * before signing, so the signed bytes have a deterministic order
 * independent of how the client constructed the object. If we sign an
 * unsorted body but Alchemy verifies against a sorted-canonical form, the
 * signature mismatches and the server returns `81003 Invalid Merchant
 * Sign`. List/GET endpoints worked without this because they pass no body.
 *
 * Callers must also POST the **sorted** body bytes, not their original
 * order — otherwise even with the sort here, the bytes the client sees and
 * the bytes we sign won't match the bytes Alchemy receives. Use
 * [stableJsonStringify] when building POST bodies.
 */
function getJsonBody(body: string | undefined): string {
  if (!body) return '';
  try {
    const map = JSON.parse(body);
    if (!map || typeof map !== 'object' || Object.keys(map).length === 0) return '';
    return stableJsonStringify(map);
  } catch {
    return '';
  }
}

/**
 * `JSON.stringify` with top-level keys sorted alphabetically. We don't
 * recurse — Alchemy's request bodies are flat key→primitive maps in
 * practice, and recursion would mask subtle bugs (e.g. arrays getting
 * silently reordered) if a future endpoint sends nested data.
 */
function stableJsonStringify(obj: Record<string, unknown>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of sortedKeys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

export function signAlchemyRequest(args: {
  method: 'GET' | 'POST';
  fullUrl: string;
  body?: string;
}): { sign: string; timestamp: string; appId: string } {
  const timestamp = Date.now().toString();
  const content =
    timestamp + args.method.toUpperCase() + getPath(args.fullUrl) + getJsonBody(args.body);

  const sign = createHmac('sha256', config.ALCHEMY_PAY_APP_SECRET)
    .update(content, 'utf8')
    .digest('base64');

  // Dev-only debug. Strip or gate behind an env flag once auth is stable.
  if (config.NODE_ENV !== 'production') {
    console.log('[alchemy-sign] content =', JSON.stringify(content));
    console.log('[alchemy-sign] appId   =', config.ALCHEMY_PAY_APP_ID);
    console.log('[alchemy-sign] ts      =', timestamp);
    console.log('[alchemy-sign] sign    =', sign);
  }

  return { sign, timestamp, appId: config.ALCHEMY_PAY_APP_ID };
}

export interface AlchemyCryptoAsset {
  crypto: string;
  network: string;
  buyEnable: number;
  sellEnable: number;
  minPurchaseAmount: number | null;
  maxPurchaseAmount: number | null;
  address: string | null;
  icon: string | null;
  minSellAmount?: number | null;
  maxSellAmount?: number | null;
}

interface AlchemyEnvelope<T> {
  success?: boolean;
  returnCode?: string;
  returnMsg?: string;
  extend?: string;
  data?: T;
}

export async function fetchCryptoList(params: { fiat?: string }): Promise<AlchemyCryptoAsset[]> {
  const url = new URL('/open/api/v4/merchant/crypto/list', config.ALCHEMY_PAY_BASE_URL);
  if (params.fiat) url.searchParams.set('fiat', params.fiat);

  const auth = signAlchemyRequest({ method: 'GET', fullUrl: url.toString() });

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      // Header names per the docs example — Alchemy expects the camelCase
      // `appId` literal (HTTP normalizes case, but matching docs avoids
      // any server-side strict comparison surprises).
      appId: auth.appId,
      timestamp: auth.timestamp,
      sign: auth.sign,
    },
  });

  const body = (await res.json()) as AlchemyEnvelope<AlchemyCryptoAsset[]>;
  if (config.NODE_ENV !== 'production') {
    console.log('[alchemy-resp]', res.status, body.returnCode, body.returnMsg);
  }

  if (!res.ok || body.success === false) {
    throw new AlchemyApiError(
      body.returnMsg ?? `Alchemy Pay cryptoList failed (HTTP ${res.status})`,
      body.returnCode ?? String(res.status),
    );
  }
  return body.data ?? [];
}

export class AlchemyApiError extends Error {
  // Explicit field + assignment instead of a constructor parameter property
  // (`public readonly code: string` in the params). Node's
  // `--experimental-strip-types` only strips type annotations — it can't
  // transform code, so parameter properties (which would need a synthetic
  // `this.code = code` in the body) throw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
  // at runtime. Keep this pattern when adding error classes.
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'AlchemyApiError';
    this.code = code;
  }
}

// ─── Hosted Ramp URL ─────────────────────────────────────────────────────────

const HOSTED_RAMP_PROD_BASE = 'https://ramp.alchemypay.org';
const HOSTED_RAMP_SANDBOX_BASE = 'https://ramptest.alchemypay.org';

/// Whether the current Alchemy base URL points at the test environment.
function isSandbox(): boolean {
  return config.ALCHEMY_PAY_BASE_URL.includes('test');
}

/**
 * Builds a SIGNED Alchemy Pay hosted ramp page URL.
 *
 * The hosted page uses a different signing algorithm than the merchant API:
 *
 *   sortedQuery = "appId=...&crypto=...&fiat=...&...&timestamp=..."  (alpha-sorted)
 *   signInput   = timestamp + "GET" + "/index/rampPageBuy?" + sortedQuery
 *   sign        = base64(HMAC-SHA256(appSecret, signInput))
 *
 * Per https://alchemypay.readme.io/docs/ramp-signature-description.
 */
export function buildHostedRampUrl(args: {
  crypto: string;
  fiat: string;
  fiatAmount: string;
  network: string;
  address?: string;
  /** Alchemy payment-method code (e.g. `10001` for credit card). When set,
      the hosted page lands directly on this method instead of showing the
      method picker. Codes are returned per fiat from `/merchant/fiat/list`. */
  payWayCode?: string;
  redirectUrl?: string;
  callbackUrl?: string;
  merchantOrderNo: string;
}): string {
  const timestamp = Date.now().toString();
  const params: Record<string, string> = {
    appId: config.ALCHEMY_PAY_APP_ID,
    crypto: args.crypto,
    fiat: args.fiat,
    fiatAmount: args.fiatAmount,
    merchantOrderNo: args.merchantOrderNo,
    network: args.network,
    showTable: 'buy',
    timestamp,
    ...(args.address ? { address: args.address } : {}),
    ...(args.payWayCode ? { payWayCode: args.payWayCode } : {}),
    ...(args.redirectUrl ? { redirectUrl: args.redirectUrl } : {}),
    ...(args.callbackUrl ? { callbackUrl: args.callbackUrl } : {}),
  };

  // Alpha-sort, join as `k=v&k=v` (raw — no URL encoding inside the signed string).
  const sortedQuery = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const signInput = `${timestamp}GET/index/rampPageBuy?${sortedQuery}`;
  const sign = createHmac('sha256', config.ALCHEMY_PAY_APP_SECRET)
    .update(signInput, 'utf8')
    .digest('base64');

  const base = isSandbox() ? HOSTED_RAMP_SANDBOX_BASE : HOSTED_RAMP_PROD_BASE;
  // Browser URL uses URL-encoded values; the sign carries through unchanged.
  const finalParams = new URLSearchParams({ ...params, sign });
  return `${base}/?${finalParams.toString()}`;
}

// ─── Quote ───────────────────────────────────────────────────────────────────

/**
 * Raw response from Alchemy's quote endpoint. Fields are strings to match
 * the wire format — callers parse to numbers downstream. We type as
 * optional everywhere because Alchemy's response shape has shifted across
 * doc versions (some keys are sometimes nested, sometimes flat).
 */
export interface AlchemyQuote {
  crypto?: string;
  network?: string;
  fiat?: string;
  /** Unit price of one crypto unit in fiat (e.g. `1.0014`). */
  cryptoPrice?: string;
  /** Fiat input echoed back. */
  fiatQuantity?: string;
  /** Estimated crypto the user receives after fees. */
  cryptoQuantity?: string;
  /** Per-crypto-per-payment-method minimum spend in fiat. */
  payMin?: string;
  /** Per-crypto-per-payment-method maximum spend in fiat. */
  payMax?: string;
  /** Provider/processing fee in fiat. */
  rampFee?: string;
  /** Estimated on-chain gas fee in fiat. */
  networkFee?: string;
  /** Payment-method identifier (e.g. `10001` for credit card). */
  payWayCode?: string;
  /** Epoch seconds when the quote expires (~30s typical). */
  rateValidUntil?: number;
}

/**
 * Calls Alchemy Pay's order quote endpoint:
 *
 *   POST /open/api/v4/merchant/order/quote
 *
 * Returns the live exchange rate, estimated crypto received, fees, and the
 * **per-crypto minimum/maximum spend** that the hosted page enforces. This
 * minimum is stricter than the global per-fiat `payMin` from `/fiat/list` —
 * e.g. USD orders globally start at 1 USD but USDC-on-Sui orders start at
 * 15 USD. We surface this to the mobile so validation matches the hosted
 * page's actual floor.
 */
export async function fetchQuote(params: {
  crypto: string;
  network: string;
  fiat: string;
  fiatAmount: string;
  /** Optional Alchemy payment-method code. When set, the quote is scoped to
      that method's specific rate, fees, and per-method limits. */
  payWayCode?: string;
}): Promise<AlchemyQuote> {
  const url = new URL('/open/api/v4/merchant/order/quote', config.ALCHEMY_PAY_BASE_URL);

  // Alchemy's merchant API V4 quote endpoint uses `amount` and `type` —
  // distinct from the hosted-ramp URL which uses `fiatAmount` and
  // `showTable`. Naming mismatch returns `10005 Invalid amount value`.
  const requestBody: Record<string, unknown> = {
    crypto: params.crypto,
    network: params.network,
    fiat: params.fiat,
    amount: params.fiatAmount,
    type: 'BUY',
    ...(params.payWayCode ? { payWayCode: params.payWayCode } : {}),
  };
  // Use stable key ordering for both the bytes we send AND the bytes we
  // sign. Mismatch → Alchemy returns 81003 "Invalid Merchant Sign".
  const bodyString = stableJsonStringify(requestBody);

  const auth = signAlchemyRequest({ method: 'POST', fullUrl: url.toString(), body: bodyString });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      appId: auth.appId,
      timestamp: auth.timestamp,
      sign: auth.sign,
    },
    body: bodyString,
  });

  const body = (await res.json()) as AlchemyEnvelope<AlchemyQuote>;
  if (config.NODE_ENV !== 'production') {
    console.log('[alchemy-resp]', res.status, body.returnCode, body.returnMsg);
  }

  if (!res.ok || body.success === false) {
    throw new AlchemyApiError(
      body.returnMsg ?? `Alchemy Pay quote failed (HTTP ${res.status})`,
      body.returnCode ?? String(res.status),
    );
  }
  return body.data ?? {};
}

// ─── Fiat List ───────────────────────────────────────────────────────────────

/**
 * Raw row Alchemy returns from `/merchant/fiat/list`. Each currency typically
 * has multiple rows — one per payment method (`payWayCode`). Downstream code
 * de-dupes to a unique-currency list for the fiat picker, then keeps the
 * payment-method rows for the create-order step where they're needed.
 */
export interface AlchemyFiatRow {
  currency: string;
  country: string;
  countryName: string;
  payWayCode: string;
  payWayName: string;
  fixedFee: number;
  feeRate: number;
  payMin: number;
  payMax: number;
}

/**
 * Calls Alchemy Pay's Fiat Query endpoint.
 *
 *   GET /open/api/v4/merchant/fiat/list?type=BUY
 *
 * `type` defaults to `BUY` (onramp). The endpoint has no crypto/network
 * filter — it returns every fiat the merchant is enabled for.
 */
export async function fetchFiatList(params: {
  type?: 'BUY' | 'SELL';
}): Promise<AlchemyFiatRow[]> {
  const url = new URL('/open/api/v4/merchant/fiat/list', config.ALCHEMY_PAY_BASE_URL);
  url.searchParams.set('type', params.type ?? 'BUY');

  const auth = signAlchemyRequest({ method: 'GET', fullUrl: url.toString() });

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      appId: auth.appId,
      timestamp: auth.timestamp,
      sign: auth.sign,
    },
  });

  const body = (await res.json()) as AlchemyEnvelope<AlchemyFiatRow[]>;
  if (config.NODE_ENV !== 'production') {
    console.log('[alchemy-resp]', res.status, body.returnCode, body.returnMsg);
  }

  if (!res.ok || body.success === false) {
    throw new AlchemyApiError(
      body.returnMsg ?? `Alchemy Pay fiatList failed (HTTP ${res.status})`,
      body.returnCode ?? String(res.status),
    );
  }
  return body.data ?? [];
}
