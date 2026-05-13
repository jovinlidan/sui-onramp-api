import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { buildHostedRampUrl, fetchCryptoList, fetchFiatList, fetchQuote } from '../lib/alchemy.ts';

const router = Router();

/**
 * The literal value Alchemy Pay returns in the `network` field for Sui mainnet
 * coins. Verify against your merchant dashboard if Alchemy ever rebrands —
 * historical alternatives have included `SUI_NETWORK`. Keeping it isolated
 * here so the fix is one line.
 */
const SUI_NETWORK = 'SUI';

/**
 * Static fallback list used while the Alchemy merchant account is pending
 * activation. Enabled via `USE_STUB_CRYPTO_LIST=true` in `.env`. The shape
 * matches what the real Alchemy proxy returns, so the mobile client doesn't
 * need a different code path.
 *
 * Symbols are the lowercase names the mobile client's coin registry
 * exposes — the client resolves these to full Sui `coinType` strings by
 * joining against whichever metadata source it already pulls (e.g. a
 * lending-market pool list).
 */
const STUB_SUI_COINS = [
  { symbol: 'SUI', network: SUI_NETWORK },
  { symbol: 'USDC', network: SUI_NETWORK },
  { symbol: 'USDT', network: SUI_NETWORK },
];

/**
 * Stand-in fiat list mirroring the shape `/buy/fiat-list` returns. Used when
 * `USE_STUB_CRYPTO_LIST=true`; keeps the mobile pill populated while Alchemy
 * activation is pending. Each fiat carries the payment methods Alchemy
 * typically supports for that currency, with plausible per-method limits.
 */
const STUB_FIATS = [
  {
    code: 'USD',
    country: 'US',
    countryName: 'United States',
    paymentMethods: [
      { payWayCode: '10001', payWayName: 'Credit Card', payMin: 15, payMax: 10000, fixedFee: 0.3, feeRate: 0.035 },
      { payWayCode: '701',   payWayName: 'Apple Pay',   payMin: 15, payMax: 5000,  fixedFee: 0.3, feeRate: 0.035 },
    ],
  },
  {
    code: 'EUR',
    country: 'EU',
    countryName: 'Eurozone',
    paymentMethods: [
      { payWayCode: '10001', payWayName: 'Credit Card', payMin: 25, payMax: 10000, fixedFee: 0.3, feeRate: 0.035 },
    ],
  },
  {
    code: 'GBP',
    country: 'GB',
    countryName: 'United Kingdom',
    paymentMethods: [
      { payWayCode: '10001', payWayName: 'Credit Card', payMin: 25, payMax: 10000, fixedFee: 0.3, feeRate: 0.035 },
    ],
  },
  {
    code: 'HKD',
    country: 'HK',
    countryName: 'Hong Kong',
    paymentMethods: [
      { payWayCode: '10001', payWayName: 'Credit Card', payMin: 200, payMax: 80000, fixedFee: 2.4, feeRate: 0.035 },
    ],
  },
];

const CryptoListQuery = z.object({
  fiat: z.string().length(3).optional(),
});

/**
 * GET /buy/crypto-list?fiat=USD
 *
 * Returns Sui-mainnet, buy-enabled cryptos. Source depends on the env flag:
 *   - `USE_STUB_CRYPTO_LIST=true`  → static list (dev fallback)
 *   - else                         → Alchemy Pay's `/merchant/crypto/list`
 */
router.get('/crypto-list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (config.USE_STUB_CRYPTO_LIST) {
      res.json({
        data: STUB_SUI_COINS.map((c) => ({
          symbol: c.symbol,
          network: c.network,
          contractAddress: null,
          icon: null,
          minPurchaseAmount: null,
          maxPurchaseAmount: null,
        })),
      });
      return;
    }

    const query = CryptoListQuery.parse(req.query);
    const assets = await fetchCryptoList({ fiat: query.fiat });

    const result = assets
      .filter((a) => a.network === SUI_NETWORK && a.buyEnable === 1)
      .map((a) => ({
        symbol: a.crypto,
        network: a.network,
        contractAddress: a.address ?? null,
        icon: a.icon ?? null,
        minPurchaseAmount: a.minPurchaseAmount,
        maxPurchaseAmount: a.maxPurchaseAmount,
      }));

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

const FiatListQuery = z.object({
  type: z.enum(['BUY', 'SELL']).default('BUY'),
});

/**
 * GET /buy/fiat-list?type=BUY
 *
 * Returns the fiat currencies Alchemy Pay supports for the requested ramp
 * direction. Each currency carries its full list of payment methods
 * (`paymentMethods`) — credit/debit card, Apple Pay, SEPA, etc. — with
 * per-method limits and fees so the mobile can render a method picker and
 * pre-select one in the hosted ramp URL via `payWayCode`.
 *
 * Previously we collapsed the matrix to a single (min, max) per currency.
 * That hid the per-method floor — e.g. USDC-on-Sui requires ≥15 USD via
 * card, even though SEPA in EUR might allow far less.
 */
router.get('/fiat-list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = FiatListQuery.parse(req.query);

    if (config.USE_STUB_CRYPTO_LIST) {
      res.json({ data: STUB_FIATS });
      return;
    }

    const rows = await fetchFiatList({ type: query.type });

    // Group payment-method rows by currency. One [BuyableFiatEntity]-shaped
    // entry per currency, carrying the full method matrix Alchemy returned.
    const byCode = new Map<
      string,
      {
        code: string;
        country: string;
        countryName: string;
        paymentMethods: Array<{
          payWayCode: string;
          payWayName: string;
          payMin: number;
          payMax: number;
          fixedFee: number;
          feeRate: number;
        }>;
      }
    >();
    for (const r of rows) {
      let entry = byCode.get(r.currency);
      if (!entry) {
        entry = {
          code: r.currency,
          country: r.country,
          countryName: r.countryName,
          paymentMethods: [],
        };
        byCode.set(r.currency, entry);
      }
      entry.paymentMethods.push({
        payWayCode: r.payWayCode,
        payWayName: r.payWayName,
        payMin: r.payMin,
        payMax: r.payMax,
        fixedFee: r.fixedFee,
        feeRate: r.feeRate,
      });
    }

    res.json({ data: Array.from(byCode.values()) });
  } catch (err) {
    next(err);
  }
});

const QuoteBody = z.object({
  crypto: z.string().min(1),
  fiat: z.string().length(3),
  fiatAmount: z.string().regex(/^\d+(\.\d+)?$/, 'fiatAmount must be a decimal string'),
  network: z.string().default(SUI_NETWORK),
  /** Optional Alchemy payment-method code (e.g. `10001` for credit card). */
  payWayCode: z.string().min(1).optional(),
});

/**
 * POST /buy/quote
 *
 * Live quote for a (crypto, fiat, network, amount) tuple. Mobile calls this
 * to:
 *   1. Surface the per-crypto minimum/maximum that the hosted page enforces
 *      (stricter than the per-fiat globals from `/fiat-list`).
 *   2. Render the "You receive ~ X CRYPTO" estimate before the user commits.
 *
 * Body is normalized — strings get parsed/typed downstream. The proxy
 * returns Alchemy's response data as-is so callers can pick whichever
 * fields they need without us churning when Alchemy adds new ones.
 *
 * In stub mode (`USE_STUB_CRYPTO_LIST=true`), we synthesize a plausible
 * quote from the requested amount so the mobile UI can be exercised
 * end-to-end without a live merchant.
 */
router.post('/quote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = QuoteBody.parse(req.body);

    if (config.USE_STUB_CRYPTO_LIST) {
      const fiatAmount = Number.parseFloat(body.fiatAmount);
      // Plausible per-crypto floor for stub mode — matches what Alchemy
      // sandbox commonly returns for USDC-on-Sui. Tweak as needed when
      // exercising the UI for other cryptos.
      const stubPayMin = body.crypto === 'SUI' ? 30 : 15;
      const stubPrice = body.crypto === 'SUI' ? 1.2 : 1.0; // arbitrary
      const cryptoQuantity = fiatAmount > 0 ? (fiatAmount / stubPrice).toFixed(6) : '0';
      res.json({
        data: {
          crypto: body.crypto,
          network: body.network,
          fiat: body.fiat,
          cryptoPrice: stubPrice.toString(),
          fiatQuantity: body.fiatAmount,
          cryptoQuantity,
          payMin: stubPayMin.toString(),
          payMax: '10000',
          rampFee: '1.50',
          networkFee: '0.10',
          payWayCode: body.payWayCode ?? '10001',
        },
      });
      return;
    }

    const quote = await fetchQuote(body);
    res.json({ data: quote });
  } catch (err) {
    next(err);
  }
});

const OrderBody = z.object({
  crypto: z.string().min(1),
  fiat: z.string().length(3),
  fiatAmount: z.string().regex(/^\d+(\.\d+)?$/, 'fiatAmount must be a decimal string'),
  network: z.string().default(SUI_NETWORK),
  address: z.string().min(1, 'address (recipient Sui wallet) is required'),
  /** Optional Alchemy payment-method code — pre-selects the method on the
      hosted ramp page (e.g. `10001` for credit card, `701` for Apple Pay).
      Omit to let Alchemy present the full picker. */
  payWayCode: z.string().min(1).optional(),
  redirectUrl: z.string().url().optional(),
  callbackUrl: z.string().url().optional(),
});

/**
 * POST /buy/order
 *
 * Builds a SIGNED Alchemy Pay hosted-ramp URL for the mobile client to open
 * in an in-app browser. We use the hosted page (vs. the merchant API
 * createOrder + getToken flow) because it's the path of least friction for v1:
 * one signed URL, no per-user token, Alchemy handles checkout UI.
 *
 * The mobile client passes its recipient Sui address; we tack on a unique
 * `merchantOrderNo` per call (callers don't need to manage that themselves).
 */
router.post('/order', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = OrderBody.parse(req.body);
    const merchantOrderNo = `sui-onramp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const url = buildHostedRampUrl({
      crypto: body.crypto,
      fiat: body.fiat,
      fiatAmount: body.fiatAmount,
      network: body.network,
      address: body.address,
      payWayCode: body.payWayCode,
      redirectUrl: body.redirectUrl,
      callbackUrl: body.callbackUrl,
      merchantOrderNo,
    });

    // Log the full hosted-ramp URL on every /buy/order call so the Railway
    // dashboard surfaces it. Lets us paste a URL into a desktop browser to
    // verify what Alchemy receives without having to instrument the mobile.
    // The URL contains no merchant secrets (the sign is HMAC output, not
    // recoverable to the key) — safe to log.
    console.log('[buy-order]', merchantOrderNo, 'payWayCode=', body.payWayCode ?? '(none)');
    console.log('[buy-order-url]', url);

    res.json({ data: { url, merchantOrderNo } });
  } catch (err) {
    next(err);
  }
});

export { router as buyRouter };
