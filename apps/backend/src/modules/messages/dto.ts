import { z } from 'zod'

export const SetFlagsSchema = z.object({
  isRead: z.boolean().optional(),
  isFlagged: z.boolean().optional(),
})

export const MoveMessageSchema = z.object({
  folderId: z.string().uuid(),
})

export const SendAttachmentSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().optional(),
  content: z.string(), // base64
})

export const SendMailSchema = z.object({
  accountId: z.string().uuid(),
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  subject: z.string(),
  html: z.string(),
  text: z.string().optional(),
  inReplyTo: z.string().optional(),
  attachments: z.array(SendAttachmentSchema).max(10).optional(),
})

export const AssignLabelSchema = z.object({
  labelId: z.string().uuid(),
})

export type SendMailDto = z.infer<typeof SendMailSchema>
