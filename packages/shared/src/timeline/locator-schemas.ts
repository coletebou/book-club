import { z } from 'zod';
import type { AudioLocator, EpubLocator, Locator, PdfLocator } from './locators';

export const EpubLocatorSchema = z.object({
  kind: z.literal('epub'),
  section: z.int().nonnegative(),
  offset: z.int().nonnegative(),
}) satisfies z.ZodType<EpubLocator>;

export const PdfLocatorSchema = z.object({
  kind: z.literal('pdf'),
  page: z.int().nonnegative(),
  y: z.number().min(0).max(1),
}) satisfies z.ZodType<PdfLocator>;

export const AudioLocatorSchema = z.object({
  kind: z.literal('audio'),
  track: z.int().nonnegative(),
  ms: z.number().nonnegative(),
}) satisfies z.ZodType<AudioLocator>;

export const LocatorSchema = z.discriminatedUnion('kind', [EpubLocatorSchema, PdfLocatorSchema, AudioLocatorSchema]) satisfies z.ZodType<Locator>;
