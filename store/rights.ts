import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LicenseWindow, RightsComment, SublicenseNode, Territory } from '@/lib/types'
import { initialComments, initialWindows, legacySublicenses } from '@/lib/mock-data'
import { findConflicts, shiftWindow } from '@/lib/rules'
import { buildChains, migrateLegacy, reconcileChildren, validateRegistration } from '@/lib/chains'

export interface MigrationReport {
  matchedCount: number
  reviewCount: number
  migratedAt: string
}

export interface RegisterInput {
  parentWindowId: string
  subChannel: string
  territory: Territory
  start: string
  end: string
  exclusive: boolean
  note?: string
}

interface RightsState {
  windows: LicenseWindow[]
  sublicenses: SublicenseNode[]
  comments: RightsComment[]
  selectedWindowId: string
  selectedTerritory: string
  version: number
  migrationReport: MigrationReport | null
  updateWindow: (id: string, patch: Partial<LicenseWindow>) => void
  setSublicenseFlag: (id: string, enabled: boolean) => void
  batchShift: (ids: string[], days: number) => void
  registerSub: (input: RegisterInput) => { ok: boolean; message: string; nodeId?: string }
  requeueSub: (id: string) => { ok: boolean; message: string }
  attachOrphan: (id: string, parentWindowId: string) => { ok: boolean; message: string }
  acceptComment: (id: string) => void
  selectWindow: (id: string) => void
  reset: () => void
}

const legacyMigration = migrateLegacy(initialWindows, legacySublicenses)

const initialState = {
  windows: initialWindows,
  sublicenses: legacyMigration.children,
  comments: initialComments,
  selectedWindowId: 'RW-102',
  selectedTerritory: '全部地区',
  version: 18,
  migrationReport: { matchedCount: legacyMigration.matchedCount, reviewCount: legacyMigration.reviewCount, migratedAt: new Date().toISOString() } satisfies MigrationReport,
}

let subSequence = 100
export function nextSubId(): string {
  subSequence += 1
  return `SUB-${subSequence}`
}

export const useRightsStore = create<RightsState>()(
  persist(
    (set, get) => ({
      ...initialState,
      updateWindow: (id, patch) => set((state) => {
        const windows: LicenseWindow[] = state.windows.map((item) => (item.id === id
          ? { ...item, ...patch, status: '草案' as const, revision: item.revision + 1 }
          : item))
        // 母窗口范围一变，超出的次级窗口马上失效（派生状态实时重算）
        const sublicenses = reconcileChildren(windows, state.sublicenses)
        return { windows, sublicenses, version: state.version + 1 }
      }),
      setSublicenseFlag: (id, enabled) => set((state) => {
        const windows: LicenseWindow[] = state.windows.map((item) => (item.id === id
          ? { ...item, sublicense: enabled, status: '草案' as const, revision: item.revision + 1 }
          : item))
        // 关掉转授权 → 整条链失效；重新开启且边界仍包含 → 恢复生效
        const sublicenses = reconcileChildren(windows, state.sublicenses)
        return { windows, sublicenses, version: state.version + 1 }
      }),
      batchShift: (ids, days) => set((state) => {
        const windows: LicenseWindow[] = state.windows.map((item) => (ids.includes(item.id)
          ? { ...shiftWindow(item, days), revision: item.revision + 1 }
          : item))
        const sublicenses = reconcileChildren(windows, state.sublicenses)
        return { windows, sublicenses, version: state.version + 1 }
      }),
      registerSub: (input) => {
        const state = get()
        const parent = state.windows.find((item) => item.id === input.parentWindowId)
        const draft: SublicenseNode = {
          id: nextSubId(),
          parentWindowId: input.parentWindowId,
          workId: parent?.workId ?? '',
          work: parent?.work ?? '',
          subChannel: input.subChannel,
          rights: parent?.rights ?? ('非院线' as const),
          territory: input.territory,
          start: input.start,
          end: input.end,
          exclusive: input.exclusive,
          note: input.note ?? '',
          basedOnRevision: parent?.revision,
          status: '待核验',
          violations: {},
        }
        const result = validateRegistration(parent, draft)
        if (!result.ok) return result
        const node: SublicenseNode = { ...draft, rights: parent!.rights, workId: parent!.workId, work: parent!.work }
        node.status = '生效中'
        node.violations = {}
        set((current) => ({
          windows: current.windows.map((item) => (item.id === parent!.id ? { ...item, revision: item.revision + 1 } : item)),
          sublicenses: [...current.sublicenses, node],
          version: current.version + 1,
        }))
        return { ok: true, message: `次级窗口 ${node.id} 已登记到母窗口 ${parent!.id} 授权链。`, nodeId: node.id }
      },
      requeueSub: (id) => {
        // 并发冲突后保留的草稿，在用户处理完母窗口后显式重新提交
        const state = get()
        const node = state.sublicenses.find((item) => item.id === id)
        if (!node) return { ok: false, message: '找不到该草稿。' }
        const parent = node.parentWindowId ? state.windows.find((item) => item.id === node.parentWindowId) : undefined
        const result = validateRegistration(parent, node)
        if (!result.ok) return result
        set((current) => ({
          sublicenses: current.sublicenses.map((item) => (item.id === id
            ? { ...item, status: '生效中' as const, violations: {}, draftReason: undefined, basedOnRevision: parent?.revision }
            : item)),
          version: current.version + 1,
        }))
        return { ok: true, message: `草稿 ${id} 已按当前母窗口范围重新提交并生效。` }
      },
      attachOrphan: (id, parentWindowId) => {
        // 待核验的存量记录由人工指定母窗口，仍要通过边界硬校验
        const state = get()
        const node = state.sublicenses.find((item) => item.id === id)
        const parent = state.windows.find((item) => item.id === parentWindowId)
        if (!node) return { ok: false, message: '找不到该待核验记录。' }
        const candidate = { ...node, parentWindowId }
        const result = validateRegistration(parent, candidate)
        if (!result.ok) return result
        set((current) => ({
          sublicenses: current.sublicenses.map((item) => (item.id === id
            ? { ...item, parentWindowId, status: '生效中' as const, violations: {}, note: `${item.note}；人工核验挂接`.replace(/^；/, ''), basedOnRevision: parent?.revision }
            : item)),
          version: current.version + 1,
        }))
        return { ok: true, message: `${id} 已核验挂接到 ${parentWindowId}。` }
      },
      acceptComment: (id) => set((state) => ({ comments: state.comments.map((item) => (item.id === id ? { ...item, resolved: true } : item)), version: state.version + 1 })),
      selectWindow: (id) => set({ selectedWindowId: id }),
      reset: () => set({ ...initialState }),
    }),
    {
      name: 'yy53-rights-draft-v1',
      version: 2,
      migrate: (persisted: unknown, version: number) => {
        const state = (persisted ?? {}) as Partial<RightsState>
        if (version < 2) {
          const windows = (state.windows ?? initialWindows).map((item) => ({ ...item, revision: item.revision ?? 1 }))
          // 老版本本地数据没有次级窗口引用：用同一套迁移逻辑补齐，对不上的留待核验
          const result = migrateLegacy(windows, state.sublicenses?.length ? state.sublicenses : legacySublicenses)
          return {
            ...initialState,
            ...state,
            windows,
            sublicenses: result.children,
            migrationReport: { matchedCount: result.matchedCount, reviewCount: result.reviewCount, migratedAt: new Date().toISOString() },
          }
        }
        return state as RightsState
      },
    },
  ),
)

export function useConflicts() {
  const windows = useRightsStore((state) => state.windows)
  return findConflicts(windows)
}

/** 授权链视图：母窗口、次级节点、冲突结论始终从当前状态实时派生 */
export function useChains() {
  const windows = useRightsStore((state) => state.windows)
  const sublicenses = useRightsStore((state) => state.sublicenses)
  return buildChains(windows, sublicenses)
}
