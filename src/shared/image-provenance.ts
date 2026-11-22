import { z } from "zod";

export const ImageProvenance = z.object({
  credential: z.enum(["trusted", "untrusted", "invalid", "absent", "unavailable"]),
  declaration: z.enum(["generated", "edited", "none"]),
  basis: z.enum(["c2pa", "metadata", "none"]),
  textPl: z.string(),
  file: z.object({
    format: z.enum(["jpeg", "png", "webp"]), width: z.number().int().positive(),
    height: z.number().int().positive(), bytes: z.number().int().positive(),
  }).optional(),
});

export type ImageProvenance = z.infer<typeof ImageProvenance>;
