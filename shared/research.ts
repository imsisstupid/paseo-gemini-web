import { z } from 'zod';

export const researchCardSchema = z.object({
  phase: z.enum(['preparing', 'plan', 'researching', 'completed', 'canceled', 'failed']),
  status: z.string(),
  plan: z.string().optional(),
  permissionId: z.string().optional(),
  url: z.string().regex(/^https:\/\/gemini\.google\.com\/app(?:\/[a-zA-Z0-9_-]+)?$/).optional(),
});
export type ResearchCard = z.infer<typeof researchCardSchema>;
