import { z } from 'zod'

export const GenerateReplySchema = z.object({
  signature: z.string().max(20000).optional(),
})

export type GenerateReplyDto = z.infer<typeof GenerateReplySchema>
