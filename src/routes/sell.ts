import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { buildHostedRampUrl, fetchFiatList, fetchQuote } from '../lib/alchemy.ts';

const router = Router();

/// Alchemy's `network` value for Sui mainnet. Kept aligned with the
/// buy-side router on purpose so both share the default.
const SUI_NETWORK = 'SUI';

const QuoteBody = z.object({
  crypto: z.string().min(1),
  fiat: z.string().length(3),
  fiatAmount: z.string().regex(/^\d+(\.\d+)?$/, 'fiatAmount must be a decimal string'),
  network: z.string().default(SUI_NETWORK),
  payWayCode: z.string().min(1).optional(),
});

/// Sell orders specify the amount of crypto to sell, not the fiat to
/// receive — that's what Alchemy's hosted off-ramp page reads.
const OrderBody = z.object({
  crypto: z.string().min(1),
  cryptoAmount: z.string().regex(/^\d+(\.\d+)?$/, 'cryptoAmount must be a decimal string'),
  network: z.string().default(SUI_NETWORK),
  address: z.string().min(1, 'address (source Sui wallet) is required'),
  fiat: z.string().length(3).optional(),
  redirectUrl: z.string().url().optional(),
  callbackUrl: z.string().url().optional(),
});

/// Alchemy's off-ramp page requires `country` alongside `fiat`. Map the
/// fiats Alchemy supports for SELL payouts to a canonical country.
/// Sent only when we have a confident mapping; otherwise the hosted page
/// falls back to its own picker.
const FIAT_TO_COUNTRY: Record<string, string> = {
  USD: 'US',
  EUR: 'DE',
  GBP: 'GB',
  HKD: 'HK',
  IDR: 'ID',
  INR: 'IN',
  JPY: 'JP',
  KRW: 'KR',
  MYR: 'MY',
  CAD: 'CA',
  AUD: 'AU',
  SGD: 'SG',
  TWD: 'TW',
  THB: 'TH',
  PHP: 'PH',
  VND: 'VN',
  BRL: 'BR',
  TRY: 'TR',
  MXN: 'MX',
  ZAR: 'ZA',
};

router.get('/fiat-list', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await fetchFiatList({ type: 'SELL' });
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/quote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = QuoteBody.parse(req.body);
    const quote = await fetchQuote({ ...body, side: 'SELL' });
    res.json({ data: quote });
  } catch (err) {
    next(err);
  }
});

router.post('/order', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = OrderBody.parse(req.body);
    const merchantOrderNo = `sui-offramp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Only send `fiat` when we can pair it with `country`; otherwise the
    // hosted page ignores fiat anyway and we'd just bloat the URL.
    const fiat = body.fiat?.toUpperCase();
    const country = fiat ? FIAT_TO_COUNTRY[fiat] : undefined;
    const fiatPair = fiat && country ? { fiat, country } : {};

    const url = buildHostedRampUrl({
      crypto: body.crypto,
      cryptoAmount: body.cryptoAmount,
      network: body.network,
      address: body.address,
      ...fiatPair,
      redirectUrl: body.redirectUrl,
      callbackUrl: body.callbackUrl,
      merchantOrderNo,
      side: 'sell',
    });
    res.json({ data: { url, merchantOrderNo } });
  } catch (err) {
    next(err);
  }
});

export { router as sellRouter };
