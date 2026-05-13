import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AlchemyApiError } from '../lib/alchemy.ts';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'bad_request',
      message: 'Invalid request parameters.',
      details: err.flatten().fieldErrors,
    });
    return;
  }

  if (err instanceof AlchemyApiError) {
    console.error('[alchemy]', err.code, err.message);
    // Relay Alchemy's user-facing returnMsg verbatim.
    res.status(502).json({
      error: 'upstream_error',
      message: err.message,
      code: err.code,
    });
    return;
  }

  console.error('[unhandled]', err);
  res.status(500).json({
    error: 'internal_error',
    message: 'Unexpected server error.',
  });
}
