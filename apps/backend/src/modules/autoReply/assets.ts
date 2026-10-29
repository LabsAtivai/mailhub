import { prisma } from '../../lib/prisma'

export const PRESENTATION_KIND = 'presentation'
export const MAX_ASSET_BYTES = 15 * 1024 * 1024 // abaixo do teto de 20MB de anexos do envio

export interface AssetMeta { kind: string; filename: string; mimeType: string; size: number; driveFileId: string | null }

export async function listAssets(accountId: string): Promise<AssetMeta[]> {
  return prisma.clientAsset.findMany({
    where: { accountId },
    select: { kind: true, filename: true, mimeType: true, size: true, driveFileId: true },
    orderBy: { kind: 'asc' },
  })
}

export async function getAssetMeta(accountId: string, kind: string): Promise<AssetMeta | null> {
  return prisma.clientAsset.findUnique({
    where: { accountId_kind: { accountId, kind } },
    select: { kind: true, filename: true, mimeType: true, size: true, driveFileId: true },
  })
}

// Conteúdo em base64, no formato que messageUseCases.send espera nos anexos.
export async function getAssetAttachment(accountId: string, kind: string) {
  const a = await prisma.clientAsset.findUnique({ where: { accountId_kind: { accountId, kind } } })
  if (!a) return null
  return { filename: a.filename, mimeType: a.mimeType, content: Buffer.from(a.content).toString('base64') }
}

export async function upsertAsset(accountId: string, input: {
  kind: string; filename: string; mimeType: string; contentBase64: string; driveFileId?: string | null
}) {
  const content = Buffer.from(input.contentBase64, 'base64')
  if (!content.length) throw new Error('Arquivo vazio')
  if (content.length > MAX_ASSET_BYTES) throw new Error('Arquivo acima de 15MB')
  const data = {
    filename: input.filename, mimeType: input.mimeType, driveFileId: input.driveFileId ?? null,
    size: content.length, content,
  }
  await prisma.clientAsset.upsert({
    where: { accountId_kind: { accountId, kind: input.kind } },
    create: { accountId, kind: input.kind, ...data },
    update: data,
  })
  return { kind: input.kind, filename: input.filename, size: content.length }
}
