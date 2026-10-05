import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { initialComments, initialWindows } from '@/lib/mock-data'
import { buildChains, findConflicts, migrateChains, validateSecondary } from '@/lib/rules'

const t = initTRPC.create()
const migratedWindows = migrateChains(initialWindows)

const windowInput = z.object({
  channel: z.string().min(2),
  start: z.string().date(),
  end: z.string().date(),
  exclusive: z.boolean(),
  parentId: z.string().optional(),
  territory: z.string().optional(),
})

export const appRouter = t.router({
  catalog: t.procedure.query(() => ({ works: ['W-001', 'W-002'], channels: ['星海影院', '云帆视频', '南华卫视', '海岛航空', '环球新媒体'] })),
  windows: t.procedure.query(() => migratedWindows),
  conflicts: t.procedure.query(() => findConflicts(migratedWindows)),
  chains: t.procedure.query(() => buildChains(migratedWindows)),
  validateWindow: t.procedure.input(windowInput).mutation(({ input }) => {
    if (new Date(input.end) < new Date(input.start)) return { valid: false, message: '窗口结束日期不能早于开始日期。' }
    const collision = migratedWindows.find((item) => item.channel === input.channel && input.start <= item.end && item.start <= input.end)
    if (collision) return { valid: false, message: `与现有窗口 ${collision.id} 重叠，请调整窗口或明确优先级。` }
    if (input.parentId) {
      const parent = migratedWindows.find((item) => item.id === input.parentId)
      if (!parent) return { valid: false, message: '母窗口不存在，无法登记次级授权。' }
      if (!parent.sublicense) return { valid: false, message: '母窗口已关闭转授权，无法登记次级授权。' }
      const child = { ...input, id: 'candidate', workId: parent.workId, work: parent.work, rights: '流媒体' as const, territory: (input.territory ?? parent.territory) as never, sublicense: false, priority: 0, status: '草案' as const }
      const violations = validateSecondary(parent, child)
      if (violations.length) return { valid: false, message: violations.join('；') }
      return { valid: true, message: '次级授权未超出母窗口范围，校验通过。' }
    }
    return { valid: true, message: '窗口结构校验通过。' }
  }),
  comments: t.procedure.query(() => initialComments),
})

export type AppRouter = typeof appRouter
