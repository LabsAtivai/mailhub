import { z } from 'zod'

export const UpsertClientProfileSchema = z.object({
  domain: z.string().trim().min(3).max(255).toLowerCase(),
  clientName: z.string().trim().min(1).max(255),
  content: z.string().max(50000),
})

export type UpsertClientProfileDto = z.infer<typeof UpsertClientProfileSchema>
