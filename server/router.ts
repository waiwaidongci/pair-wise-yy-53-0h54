import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { initialComments, initialWindows, legacySublicenses } from '@/lib/mock-data'
import { findConflicts } from '@/lib/rules'
import {
  buildChains,
  checkSubAgainstParent,
  migrateLegacy,
  orphanChildren,
  reconcileChildren,
  validateRegistration,
} from '@/lib/chains'
import type {
  LicenseWindow,
  PendingDraft,
  RaceResult,
  RaceSubmitResult,
  SublicenseNode,
  Territory,
} from '@/lib/types'

const t = initTRPC.create()

/* ------------------------------ 服务端内存世界 ------------------------------ */

function seed(): { windows: LicenseWindow[]; sublicenses: SublicenseNode[] } {
  const migration = migrateLegacy(initialWindows, legacySublicenses.map((item) => ({ ...item })))
  return { windows: initialWindows.map((item) => ({ ...item })), sublicenses: migration.children }
}

let world = seed()
let drafts: PendingDraft[] = []
const eventLog: { time: string; text: string }[] = []
let subSeq = 100
let draftSeq = 50
let arrivalSeq = 0

function snapshot(text: string) {
  eventLog.unshift({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), text })
  if (eventLog.length > 30) eventLog.pop()
}

snapshot(`服务端世界初始化：${world.sublicenses.length} 条存量次级登记完成迁移挂链`)

/* --------------------------------- 输入 schema --------------------------------- */

const windowInput = z.object({
  channel: z.string().min(2),
  start: z.string().date(),
  end: z.string().date(),
  exclusive: z.boolean(),
})

const registerInput = z.object({
  parentWindowId: z.string().min(1),
  subChannel: z.string().min(2),
  territory: z.enum(['中国大陆', '中国香港', '中国台湾', '新加坡', '马来西亚', '东南亚区域', '北美']),
  start: z.string().date(),
  end: z.string().date(),
  exclusive: z.boolean(),
  note: z.string().optional(),
})

const adjustInput = z.object({
  parentWindowId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  patch: z.object({
    start: z.string().date().optional(),
    end: z.string().date().optional(),
    territory: z.enum(['中国大陆', '中国香港', '中国台湾', '新加坡', '马来西亚', '东南亚区域', '北美']).optional(),
    exclusive: z.boolean().optional(),
    sublicense: z.boolean().optional(),
  }),
  author: z.string().default('匿名提交'),
})

const registerWithRevisionInput = registerInput.extend({
  expectedRevision: z.number().int().nonnegative(),
  author: z.string().default('匿名提交'),
})

/* ------------------------------- 核心写入原语 ------------------------------- */

interface ApplyResult {
  applied: boolean
  message: string
  currentRevision: number
  nodeId?: string
  draftId?: string
}

function applyAdjust(args: { parentWindowId: string; expectedRevision: number; patch: z.infer<typeof adjustInput>['patch']; author: string; arrivedOrder: number }): ApplyResult {
  const parent = world.windows.find((item) => item.id === args.parentWindowId)
  if (!parent) return { applied: false, message: '母窗口不存在。', currentRevision: 0 }
  if (args.expectedRevision !== parent.revision) {
    return stashDraft({
      kind: 'adjust',
      parentWindowId: parent.id,
      author: args.author,
      arrivedOrder: args.arrivedOrder,
      expectedRevision: args.expectedRevision,
      payload: args.patch,
      conflict: `母窗口在你编辑期间已被其他提交更新（版本 ${args.expectedRevision} → ${parent.revision}），本次调整保留为草稿，请基于最新范围复核。`,
    })
  }
  const next: LicenseWindow = { ...parent, ...args.patch, status: '草案' }
  if (new Date(next.end) < new Date(next.start)) {
    return { applied: false, message: '窗口结束日期不能早于开始日期。', currentRevision: parent.revision }
  }
  world.windows = world.windows.map((item) => (item.id === parent.id ? { ...next, revision: parent.revision + 1 } : item))
  world.sublicenses = reconcileChildren(world.windows, world.sublicenses)
  const linked = world.sublicenses.filter((item) => item.parentWindowId === parent.id)
  const chainOff = args.patch.sublicense === false
  const outOfRange = linked.filter((item) => item.status === '已失效-超出母窗口').length
  const chainDisabled = linked.filter((item) => item.status === '已失效-母窗口关闭转授权').length
  let detail = ''
  if (chainOff && chainDisabled > 0) detail = `，转授权关闭，链上 ${chainDisabled} 个次级窗口整链失效`
  else if (outOfRange > 0) detail = `，链上 ${outOfRange} 个越界次级窗口已立即失效`
  snapshot(`${args.author} 的母窗口调整第 ${args.arrivedOrder} 个到达并生效（${parent.id} → rev ${parent.revision + 1}）${detail}`)
  return { applied: true, message: `母窗口 ${parent.id} 已调整并生效（rev ${parent.revision + 1}）${detail}。`, currentRevision: parent.revision + 1 }
}

function applyRegister(args: { input: z.infer<typeof registerInput>; expectedRevision: number; author: string; arrivedOrder: number }): ApplyResult {
  const parent = world.windows.find((item) => item.id === args.input.parentWindowId)
  if (!parent) return { applied: false, message: '母窗口不存在。', currentRevision: 0 }
  const node: SublicenseNode = {
    id: `SUB-${++subSeq}`,
    parentWindowId: parent.id,
    workId: parent.workId,
    work: parent.work,
    subChannel: args.input.subChannel,
    rights: parent.rights,
    territory: args.input.territory as Territory,
    start: args.input.start,
    end: args.input.end,
    exclusive: args.input.exclusive,
    note: args.input.note ?? '',
    basedOnRevision: args.expectedRevision,
    status: '待核验',
    violations: {},
  }
  if (args.expectedRevision !== parent.revision) {
    return stashDraft({
      kind: 'register',
      parentWindowId: parent.id,
      author: args.author,
      arrivedOrder: args.arrivedOrder,
      expectedRevision: args.expectedRevision,
      payload: args.input as unknown as Record<string, unknown>,
      conflict: `母窗口在你填表期间已被其他提交更新（版本 ${args.expectedRevision} → ${parent.revision}），次级登记保留为草稿，请核对最新日期、地区与独占范围。`,
      node,
    })
  }
  const validation = validateRegistration(parent, node)
  if (!validation.ok) {
    return { applied: false, message: validation.message, currentRevision: parent.revision }
  }
  const bumped: LicenseWindow = { ...parent, revision: parent.revision + 1 }
  world.windows = world.windows.map((item) => (item.id === parent.id ? bumped : item))
  const effective: SublicenseNode = { ...node, status: '生效中', violations: {}, basedOnRevision: bumped.revision }
  world.sublicenses = [...world.sublicenses, effective]
  snapshot(`${args.author} 的次级登记第 ${args.arrivedOrder} 个到达并生效（${effective.id} 挂入 ${parent.id}，rev ${bumped.revision}）`)
  return { applied: true, message: `次级窗口 ${effective.id} 已登记并进入授权链（基于 rev ${bumped.revision}）。`, currentRevision: bumped.revision, nodeId: effective.id }
}

function stashDraft(args: {
  kind: 'adjust' | 'register'
  parentWindowId: string
  author: string
  arrivedOrder: number
  expectedRevision: number
  payload: Record<string, unknown>
  conflict: string
  node?: SublicenseNode
}): ApplyResult {
  const parent = world.windows.find((item) => item.id === args.parentWindowId)!
  const draftId = `DRFT-${++draftSeq}`
  let draftNodeId: string | undefined
  if (args.kind === 'register' && args.node) {
    // 后到的次级登记：留在链上但保持草稿-冲突，界面能直接看到它与最新母窗口的冲突
    const draftNode: SublicenseNode = {
      ...args.node,
      status: '草稿-冲突',
      draftReason: args.conflict,
      violations: checkSubAgainstParent(parent, args.node),
    }
    world.sublicenses = [...world.sublicenses, draftNode]
    draftNodeId = draftNode.id
    snapshot(`${args.author} 的次级登记第 ${args.arrivedOrder} 个到达，但母窗口版本已变化，保留草稿 ${draftId}`)
  } else {
    snapshot(`${args.author} 的母窗口调整第 ${args.arrivedOrder} 个到达，但母窗口版本已变化，保留草稿 ${draftId}`)
  }
  drafts = [...drafts, {
    id: draftId,
    kind: args.kind,
    parentWindowId: args.parentWindowId,
    author: args.author,
    arrivedAt: new Date().toISOString(),
    arrivedOrder: args.arrivedOrder,
    expectedRevision: args.expectedRevision,
    currentRevision: parent.revision,
    payload: args.payload,
    conflict: args.conflict,
    nodeId: draftNodeId,
  }]
  return { applied: false, message: args.conflict, currentRevision: parent.revision, draftId }
}

/* ---------------------------------- router ---------------------------------- */

export const appRouter = t.router({
  catalog: t.procedure.query(() => ({ works: ['W-001', 'W-002'], channels: ['星海影院', '云帆视频', '南华卫视', '海岛航空', '环球新媒体'] })),
  windows: t.procedure.query(() => world.windows),
  sublicenses: t.procedure.query(() => world.sublicenses),
  chains: t.procedure.query(() => buildChains(world.windows, world.sublicenses)),
  orphans: t.procedure.query(() => orphanChildren(world.sublicenses)),
  conflicts: t.procedure.query(() => findConflicts(world.windows)),
  drafts: t.procedure.query(() => drafts),
  eventLog: t.procedure.query(() => eventLog),
  validateWindow: t.procedure.input(windowInput).mutation(({ input }) => {
    if (new Date(input.end) < new Date(input.start)) return { valid: false, message: '窗口结束日期不能早于开始日期。' }
    const collision = world.windows.find((item) => item.channel === input.channel && input.start <= item.end && item.start <= input.end)
    return collision ? { valid: false, message: `与现有窗口 ${collision.id} 重叠，请调整窗口或明确优先级。` } : { valid: true, message: '窗口结构校验通过。' }
  }),
  registerSub: t.procedure.input(registerWithRevisionInput).mutation(({ input }) => {
    const { expectedRevision, author, ...rest } = input
    return applyRegister({ input: rest, expectedRevision, author, arrivedOrder: ++arrivalSeq })
  }),
  adjustParent: t.procedure.input(adjustInput).mutation(({ input }) => {
    return applyAdjust({ parentWindowId: input.parentWindowId, expectedRevision: input.expectedRevision, patch: input.patch, author: input.author, arrivedOrder: ++arrivalSeq })
  }),
  /**
   * 并发演练：两人基于同一母窗口版本，同时提交“母窗口调整”和“次级登记”。
   * 按到达顺序（first 先到）串行落库：先到者生效并把 revision +1，
   * 后到者 expectedRevision 对不上 → 不生效，保留草稿并返回冲突说明。
   */
  race: t.procedure.input(z.object({
    parentWindowId: z.string().min(1),
    baseRevision: z.number().int().nonnegative(),
    first: z.enum(['adjust', 'register']),
    adjustAuthor: z.string().default('发行·章宁'),
    registerAuthor: z.string().default('渠道·方哲'),
    adjustPatch: adjustInput.shape.patch,
    register: registerInput.omit({ parentWindowId: true }),
  })).mutation(({ input }): RaceResult => {
    const parent = world.windows.find((item) => item.id === input.parentWindowId)
    if (!parent) throw new Error('母窗口不存在')
    if (input.baseRevision !== parent.revision) {
      throw new Error(`当前母窗口版本为 rev ${parent.revision}，演练需要基于最新版本开始，请重置后再试。`)
    }
    const steps = [
      { kind: input.first, order: 1 },
      { kind: input.first === 'adjust' ? 'register' : 'adjust', order: 2 },
    ] as const
    const outcomes: RaceSubmitResult[] = []
    for (const step of steps) {
      if (step.kind === 'adjust') {
        const result = applyAdjust({ parentWindowId: input.parentWindowId, expectedRevision: input.baseRevision, patch: input.adjustPatch, author: input.adjustAuthor, arrivedOrder: step.order })
        outcomes.push({ kind: 'adjust', author: input.adjustAuthor, arrivedOrder: step.order, expectedRevision: input.baseRevision, applied: result.applied, message: result.message, draftId: result.draftId, currentRevision: result.currentRevision })
      } else {
        const result = applyRegister({ input: { ...input.register, parentWindowId: input.parentWindowId }, expectedRevision: input.baseRevision, author: input.registerAuthor, arrivedOrder: step.order })
        outcomes.push({ kind: 'register', author: input.registerAuthor, arrivedOrder: step.order, expectedRevision: input.baseRevision, applied: result.applied, message: result.message, nodeId: result.nodeId, draftId: result.draftId, currentRevision: result.currentRevision })
      }
    }
    const [firstResult, secondResult] = outcomes as [RaceSubmitResult, RaceSubmitResult]
    const newRevision = world.windows.find((item) => item.id === input.parentWindowId)!.revision
    return { winner: firstResult, loser: secondResult, newRevision }
  }),
  /** 后到方在看清冲突、处理完母窗口后，把草稿按当前版本重新提交 */
  requeueDraft: t.procedure.input(z.object({ draftId: z.string().min(1) })).mutation(({ input }) => {
    const draft = drafts.find((item) => item.id === input.draftId)
    if (!draft) return { ok: false as const, message: '草稿不存在或已被处理。' }
    // 显式重提：以母窗口当前版本为准做乐观锁与边界校验，而不是入箱时的旧版本
    const liveParent = world.windows.find((item) => item.id === draft.parentWindowId)
    if (!liveParent) return { ok: false as const, message: '母窗口已不存在，无法重新提交。' }
    if (draft.kind === 'adjust') {
      const result = applyAdjust({ parentWindowId: draft.parentWindowId, expectedRevision: liveParent.revision, patch: draft.payload as z.infer<typeof adjustInput>['patch'], author: draft.author, arrivedOrder: ++arrivalSeq })
      if (result.applied) drafts = drafts.filter((item) => item.id !== draft.id)
      return { ok: result.applied, message: result.message }
    }
    const result = applyRegister({ input: draft.payload as z.infer<typeof registerInput>, expectedRevision: liveParent.revision, author: draft.author, arrivedOrder: ++arrivalSeq })
    if (result.applied) {
      drafts = drafts.filter((item) => item.id !== draft.id)
      // 重新提交成功，精确移除链上原来的草稿节点
      if (draft.nodeId) world.sublicenses = world.sublicenses.filter((item) => item.id !== draft.nodeId)
    }
    return { ok: result.applied, message: result.message }
  }),
  /** 待核验的存量记录人工指定母窗口，仍需通过日期/地区/独占硬校验 */
  attachOrphan: t.procedure.input(z.object({ id: z.string().min(1), parentWindowId: z.string().min(1) })).mutation(({ input }) => {
    const node = world.sublicenses.find((item) => item.id === input.id)
    const parent = world.windows.find((item) => item.id === input.parentWindowId)
    if (!node) return { ok: false as const, message: '找不到该待核验记录。' }
    const candidate = { ...node, parentWindowId: input.parentWindowId }
    const validation = validateRegistration(parent, candidate)
    if (!validation.ok) return { ok: false as const, message: validation.message }
    const bumped = { ...parent!, revision: parent!.revision + 1 }
    world.windows = world.windows.map((item) => (item.id === bumped.id ? bumped : item))
    world.sublicenses = world.sublicenses.map((item) => (item.id === node.id
      ? { ...item, parentWindowId: bumped.id, status: '生效中' as const, violations: {}, note: `${item.note}；人工核验挂接`.replace(/^；/, ''), basedOnRevision: bumped.revision }
      : item))
    snapshot(`${node.id} 经人工核验挂接到母窗口 ${bumped.id}（rev ${bumped.revision}）`)
    return { ok: true as const, message: `${node.id} 已核验挂接到 ${bumped.id}。` }
  }),
  /** 服务端世界恢复到初始迁移状态 */
  resetWorld: t.procedure.mutation(() => {
    world = seed()
    drafts = []
    arrivalSeq = 0
    subSeq = 100
    draftSeq = 50
    eventLog.length = 0
    snapshot('服务端世界已重置为初始迁移状态')
    return { ok: true as const, windows: world.windows, sublicenses: world.sublicenses }
  }),
  comments: t.procedure.query(() => initialComments),
})

export type AppRouter = typeof appRouter
