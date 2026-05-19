import express from 'express';
import { config } from './config.ts';
import { buyRouter } from './routes/buy.ts';
import { sellRouter } from './routes/sell.ts';
import { errorHandler } from './middleware/error.ts';

const app = express();

app.use(express.json({ limit: '64kb' }));

app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/buy', buyRouter);
app.use('/sell', sellRouter);

app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  console.log(`[onramp-api] listening on :${config.PORT} (${config.NODE_ENV})`);
  // One-shot egress-IP probe — Alchemy Pay requires the caller IP to be
  // whitelisted on prod. Log it on every boot so the IP for the current
  // deployment is visible without exec'ing into the container.
  fetch('https://api.ipify.org')
    .then((r) => r.text())
    .then((ip) => console.log(`[egress-ip] ${ip.trim()}`))
    .catch((e) => console.warn('[egress-ip] probe failed:', e));
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[onramp-api] received ${signal}, draining...`);
    server.close(() => process.exit(0));
  });
}
