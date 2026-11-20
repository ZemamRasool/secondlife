// Shared route helpers: turn AppError into clean JSON, and the input shapes forms send.
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { AppError } from "../services/listings.js";

/** Wrap an async route: AppError → { error } with its status; anything else → the error handler. */
export const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new AppError(400, `${first.path.join(".") || "input"}: ${first.message}`);
  }
  return r.data;
}

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const listingBody = z.object({
  type: z.enum(["codebase", "domain", "website"]),
  title: text(5, 90),
  summary: text(10, 200),
  description: text(40, 8000),
  price: z.number().positive().max(10_000_000),
  techStack: z.array(z.string().max(40)).max(20).default([]),
  whatsMissing: optionalText(3000),
  traction: optionalText(1000),
  monthlyVisitors: z.number().int().min(0).max(1_000_000_000).optional().nullable(),
});

export const toListingInput = (b: z.infer<typeof listingBody>) => ({
  type: b.type,
  title: b.title,
  summary: b.summary,
  description: b.description,
  priceCents: Math.round(b.price * 100),
  techStack: b.techStack,
  whatsMissing: b.whatsMissing,
  traction: b.traction,
  monthlyVisitors: b.monthlyVisitors ?? null,
});
