import { z } from "zod";

export const ImageProvenance = z.object({
  credential: z.enum(["trusted", "untrusted", "invalid", "absent", "unavailable"]),
  declaration: z.enum(["generated", "edited", "none"]),
  basis: z.enum(["c2pa", "metadata", "none"]),
  textPl: z.string(),
});

export type ImageProvenance = z.infer<typeof ImageProvenance>;
