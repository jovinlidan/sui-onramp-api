import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AlchemyApiError } from '../lib/alchemy.ts';

/**
 * Centralized error handler. Surfaces a stable shape to the mobile client
 * without leaking server internals; logs the full error server-side.
 */
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
    // Surface Alchemy's actual `returnMsg` to the client so the mobile
    // can show a meaningful error and curl debugging works without
    // hopping into Railway's log dashboard. Safe to do: Alchemy's
    // messages are user-facing (e.g. "Amount must be ≥ 30 USD"), not
    // server internals.
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
