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

const OrderBody = z.object({
  crypto: z.string().min(1),
  fiat: z.string().length(3),
  fiatAmount: z.string().regex(/^\d+(\.\d+)?$/, 'fiatAmount must be a decimal string'),
  network: z.string().default(SUI_NETWORK),
  address: z.string().min(1, 'address (source Sui wallet) is required'),
  redirectUrl: z.string().url().optional(),
  callbackUrl: z.string().url().optional(),
});

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
    const url = buildHostedRampUrl({
      crypto: body.crypto,
      fiat: body.fiat,
      fiatAmount: body.fiatAmount,
      network: body.network,
      address: body.address,
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
