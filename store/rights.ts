import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LicenseWindow, RightsComment } from '@/lib/types'
import { initialComments, initialWindows } from '@/lib/mock-data'
import { findConflicts, migrateChains, revalidateChain, shiftWindow, validateSecondary } from '@/lib/rules'

export interface RegisterSecondaryInput {
  channel: string
  rights: LicenseWindow['rights']
  territory: LicenseWindow['territory']
  start: string
  end: string
  exclusive: boolean
  priority?: number
}

export type RegisterSecondaryResult =
  | { ok: true; status: '已确认' | '草案'; concurrent: boolean; violations: string[] }
  | { ok: false; reason: string }

interface RightsState {
  windows: LicenseWindow[]
  comments: RightsComment[]
  selectedWindowId: string
  selectedTerritory: string
  version: number
  updateWindow: (id: string, patch: Partial<LicenseWindow>) => void
  batchShift: (ids: string[], days: number) => void
  registerSecondary: (parentId: string, data: RegisterSecondaryInput, parentRev: number) => RegisterSecondaryResult
  dismissVerification: (id: string) => void
  linkToParent: (id: string, parentId: string) => void
  acceptComment: (id: string) => void
  selectWindow: (id: string) => void
  reset: () => void
}

const migratedInitial = migrateChains(initialWindows)

export const useRightsStore = create<RightsState>()(
  persist(
    (set, get) => ({
      windows: migratedInitial,
      comments: initialComments,
      selectedWindowId: 'RW-102',
      selectedTerritory: '全部地区',
      version: 18,
      updateWindow: (id, patch) => set((state) => {
        const windows = state.windows.map((item) =>
          item.id === id
            ? { ...item, ...patch, status: '草案' as const, rev: (item.rev ?? 0) + 1 }
            : item,
        )
        const edited = windows.find((item) => item.id === id)!
        let next = windows
        // 母窗口范围或转授权变更后，重算整条授权链
        if (edited.parentId) next = revalidateChain(next, edited.parentId)
        if (edited.sublicense || next.some((item) => item.parentId === id)) next = revalidateChain(next, id)
        return { windows: next, version: state.version + 1 }
      }),
      batchShift: (ids, days) => set((state) => {
        let next = state.windows.map((item) => (ids.includes(item.id) ? shiftWindow(item, days) : item))
        for (const id of ids) {
          const shifted = next.find((item) => item.id === id)
          if (shifted?.parentId) next = revalidateChain(next, shifted.parentId)
          if (shifted && (shifted.sublicense || next.some((item) => item.parentId === id))) next = revalidateChain(next, id)
        }
        return { windows: next, version: state.version + 1 }
      }),
      registerSecondary: (parentId, data, parentRev) => {
        const state = get()
        const parent = state.windows.find((item) => item.id === parentId)
        if (!parent) return { ok: false, reason: '母窗口不存在，无法登记次级授权。' }
        if (!parent.sublicense) return { ok: false, reason: '母窗口已关闭转授权，无法登记次级授权。' }
        const concurrent = (parent.rev ?? 0) !== parentRev
        const child: LicenseWindow = {
          id: `RW-${Date.now()}`,
          workId: parent.workId,
          work: parent.work,
          channel: data.channel,
          rights: data.rights,
          territory: data.territory,
          start: data.start,
          end: data.end,
          exclusive: data.exclusive,
          sublicense: false,
          priority: data.priority ?? parent.priority + 1,
          status: '草案',
          parentId,
          chainId: parent.chainId ?? parent.id,
          rev: 1,
        }
        const violations = validateSecondary(parent, child)
        // 并发提交（母窗口已被他人调整）或超出母窗口范围：留草稿并保留冲突结论
        child.status = violations.length || concurrent ? '草案' : '已确认'
        set((state) => ({ windows: [...state.windows, child], version: state.version + 1 }))
        return { ok: true, status: child.status, concurrent, violations }
      },
      dismissVerification: (id) => set((state) => ({
        windows: state.windows.map((item) =>
          item.id === id ? { ...item, needsVerification: false, status: '草案' as const, chainId: item.chainId ?? item.id } : item,
        ),
        version: state.version + 1,
      })),
      linkToParent: (id, parentId) => set((state) => {
        const parent = state.windows.find((item) => item.id === parentId)
        if (!parent) return state
        return {
          windows: state.windows.map((item) => {
            if (item.id !== id) return item
            const linked: LicenseWindow = { ...item, parentId, chainId: parent.chainId ?? parent.id, needsVerification: false, status: '草案' }
            const violations = validateSecondary(parent, linked)
            return { ...linked, status: violations.length ? '已失效' : '已确认' }
          }),
          version: state.version + 1,
        }
      }),
      acceptComment: (id) => set((state) => ({ comments: state.comments.map((item) => item.id === id ? { ...item, resolved: true } : item), version: state.version + 1 })),
      selectWindow: (id) => set({ selectedWindowId: id }),
      reset: () => set({ windows: migratedInitial, comments: initialComments, version: 18 }),
    }),
    {
      name: 'yy53-rights-draft-v2',
      version: 2,
      migrate: (persisted) => {
        const p = persisted as { windows?: LicenseWindow[] } | null
        if (!p?.windows) return { windows: migratedInitial, comments: initialComments, version: 18 }
        return { ...p, windows: migrateChains(p.windows) }
      },
    },
  ),
)

export function useConflicts() {
  const windows = useRightsStore((state) => state.windows)
  return findConflicts(windows)
}
