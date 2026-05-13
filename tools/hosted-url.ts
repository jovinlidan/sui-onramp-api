/**
 * Generates a SIGNED Alchemy Pay hosted-ramp URL for browser testing.
 *
 * Hosted-page signing format (per alchemypay.readme.io/docs/ramp-signature-description):
 *
 *   sortedQuery = "appId=...&crypto=...&fiat=...&...&timestamp=..."  // alpha-sorted
 *   signInput   = timestamp + "GET" + "/index/rampPageBuy?" + sortedQuery
 *   sign        = base64(HMAC-SHA256(appSecret, signInput))
 *
 * The signed path uses the fixed internal route `/index/rampPageBuy?`, NOT
 * the public URL path. The public URL itself is `https://ramptest.alchemypay.org/`.
 *
 * Run: pnpm tsx --env-file=.env tools/hosted-url.ts
 */
import { createHmac } from 'node:crypto';
import { config } from '../src/config.ts';

const SANDBOX_BASE = 'https://ramptest.alchemypay.org';
const SIGN_PATH = '/index/rampPageBuy?'; // documented constant in the sign input

// `merchantOrderNo` must be unique per call; the timestamp keeps each run distinct.
const timestamp = Date.now().toString();
const orderNo = `test-${timestamp}`;

const params: Record<string, string> = {
  appId: config.ALCHEMY_PAY_APP_ID,
  crypto: 'USDT',
  fiat: 'USD',
  fiatAmount: '100',
  merchantOrderNo: orderNo,
  network: 'SUI',
  showTable: 'buy',
  timestamp,
};

// Alphabetically sort by key, join as `key=value&key=value` (raw — no URL encoding
// inside the signed string).
const sortedQuery = Object.entries(params)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${k}=${v}`)
  .join('&');

const signInput = `${timestamp}GET${SIGN_PATH}${sortedQuery}`;
const sign = createHmac('sha256', config.ALCHEMY_PAY_APP_SECRET)
  .update(signInput, 'utf8')
  .digest('base64');

// Browser URL uses URL-encoded values; the signature carries through unchanged.
const finalParams = new URLSearchParams({ ...params, sign });
const url = `${SANDBOX_BASE}/?${finalParams.toString()}`;

console.log('Signed input :', signInput);
console.log('Sign (b64)   :', sign);
console.log('\nOpen in browser:\n');
console.log(url);
