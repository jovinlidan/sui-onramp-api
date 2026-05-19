import { z } from 'zod';

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ALCHEMY_PAY_APP_ID: z.string().min(1, 'ALCHEMY_PAY_APP_ID is required'),
  ALCHEMY_PAY_APP_SECRET: z.string().min(1, 'ALCHEMY_PAY_APP_SECRET is required'),
  ALCHEMY_PAY_BASE_URL: z
    .string()
    .url()
    .default('https://openapi.alchemypay.org'),
  USE_STUB_CRYPTO_LIST: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
export type Config = typeof config;
