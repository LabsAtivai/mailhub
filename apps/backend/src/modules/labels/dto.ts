import { z } from 'zod'

export const CreateLabelSchema = z.object({
  name: z.string().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor inválida (use hex #rrggbb)'),
})

export const UpdateLabelSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
})
