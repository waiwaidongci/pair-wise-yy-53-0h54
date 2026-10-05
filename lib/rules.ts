import type { LicenseWindow, Territory } from './types'

export interface ConflictIssue {
  id: string
  type: '时间重叠' | '地区交叉' | '窗口倒挂' | '独占冲突' | '授权链冲突'
  severity: '高' | '中'
  windowIds: string[]
  title: string
  explanation: string
}

export interface Chain {
  root: LicenseWindow
  secondaries: LicenseWindow[]
  valid: boolean
  issues: ConflictIssue[]
}

const order = ['院线', '电视', '流媒体', '航空', '非院线']

/** 地区包含关系：母地区是否覆盖次级地区 */
export function territoryContains(parent: Territory, child: Territory): boolean {
  if (parent === child) return true
  if (parent === '东南亚区域') return child === '新加坡' || child === '马来西亚'
  return false
}

function dateWithin(child: LicenseWindow, parent: LicenseWindow): boolean {
  return parent.start <= child.start && child.end <= parent.end
}

/** 校验次级授权是否超出母窗口范围，返回违规说明列表（空数组表示通过） */
export function validateSecondary(parent: LicenseWindow, child: LicenseWindow): string[] {
  const violations: string[] = []
  if (!parent.sublicense) violations.push('母窗口已关闭转授权，整条授权链失效')
  if (!dateWithin(child, parent)) violations.push(`次级窗口日期超出母窗口范围（母窗口 ${parent.start} → ${parent.end}）`)
  if (!territoryContains(parent.territory, child.territory)) violations.push(`次级地区 ${child.territory} 超出母地区 ${parent.territory}`)
  if (child.exclusive && !parent.exclusive) violations.push('母窗口为非独占，次级不得登记独占授权')
  return violations
}

/** 单条次级授权相对母窗口的冲突结论 */
export function chainConflictFor(parent: LicenseWindow, child: LicenseWindow): ConflictIssue | null {
  const violations = validateSecondary(parent, child)
  if (!violations.length) return null
  return {
    id: `${child.id}-CHAIN`,
    type: '授权链冲突',
    severity: '高',
    windowIds: [child.id, parent.id],
    title: `次级窗口 ${child.channel} 超出母窗口 ${parent.channel} 授权范围`,
    explanation: violations.join('；'),
  }
}

/** 全部授权链的冲突结论 */
export function findChainConflicts(windows: LicenseWindow[]): ConflictIssue[] {
  const issues: ConflictIssue[] = []
  for (const win of windows) {
    if (!win.parentId) continue
    const parent = windows.find((item) => item.id === win.parentId)
    if (!parent) {
      issues.push({ id: `${win.id}-ORPHAN`, type: '授权链冲突', severity: '高', windowIds: [win.id], title: `次级窗口 ${win.channel} 缺少母窗口引用`, explanation: '该次级授权未找到母窗口，授权链不完整，请核验后重新挂载。' })
      continue
    }
    const issue = chainConflictFor(parent, win)
    if (issue) issues.push(issue)
  }
  return issues
}

/** 母窗口范围或转授权开关变更后，重算其下所有次级窗口的有效性 */
export function revalidateChain(windows: LicenseWindow[], parentId: string): LicenseWindow[] {
  const parent = windows.find((item) => item.id === parentId)
  if (!parent) return windows
  return windows.map((win) => {
    if (win.parentId !== parentId) return win
    const violations = validateSecondary(parent, win)
    if (violations.length) return { ...win, status: '已失效' as const }
    return { ...win, status: win.status === '已失效' ? ('已确认' as const) : win.status }
  })
}

/** 把窗口列表组织成授权链（母窗口 → 次级授权 → 冲突结论） */
export function buildChains(windows: LicenseWindow[]): Chain[] {
  const roots = windows.filter((win) => win.sublicense || win.chainId === win.id)
  const chains: Chain[] = roots.map((root) => {
    const secondaries = windows.filter((win) => win.parentId === root.id)
    const issues = secondaries
      .map((sec) => chainConflictFor(root, sec))
      .filter((item): item is ConflictIssue => item !== null)
    return { root, secondaries, valid: issues.length === 0, issues }
  })
  return chains.sort((a, b) => a.root.id.localeCompare(b.root.id))
}

/**
 * 旧数据迁移：
 * - 开着转授权的窗口作为链根，chainId 指向自身；
 * - 已有母引用的，补全 chainId；
 * - 无母引用的次级候选（legacySecondary）尝试匹配包含它的母窗口，
 *   匹配上则挂载，对不上则标记待核验；
 * - 其余独立窗口自成一链。
 */
export function migrateChains(windows: LicenseWindow[]): LicenseWindow[] {
  const result: LicenseWindow[] = windows.map((win) => ({ ...win }))
  // 第一遍：确定链根
  for (const win of result) {
    win.rev = win.rev ?? 1
    if (win.sublicense) {
      win.chainId = win.id
      win.parentId = win.parentId ?? null
    }
  }
  // 第二遍：挂载次级候选
  for (const win of result) {
    if (win.parentId) {
      const parent = result.find((item) => item.id === win.parentId)
      win.chainId = parent?.chainId ?? win.parentId
      continue
    }
    if (win.sublicense) continue // 已是链根
    if (win.legacySecondary) {
      const parent = result.find(
        (item) =>
          item.workId === win.workId &&
          item.sublicense &&
          item.id !== win.id &&
          dateWithin(win, item) &&
          territoryContains(item.territory, win.territory) &&
          (!win.exclusive || item.exclusive),
      )
      if (parent) {
        win.parentId = parent.id
        win.chainId = parent.chainId ?? parent.id
        win.needsVerification = false
        if (validateSecondary(parent, win).length) win.status = '已失效'
      } else {
        win.needsVerification = true
        win.status = '待核验'
      }
    } else {
      win.chainId = win.id
      win.parentId = null
    }
  }
  return result
}

export function findConflicts(windows: LicenseWindow[]): ConflictIssue[] {
  const issues: ConflictIssue[] = []
  for (let i = 0; i < windows.length; i += 1) {
    const a = windows[i]!
    for (let j = i + 1; j < windows.length; j += 1) {
      const b = windows[j]!
      if (a.workId !== b.workId || a.territory !== b.territory) continue
      const overlap = new Date(a.start) <= new Date(b.end) && new Date(b.start) <= new Date(a.end)
      if (overlap && a.exclusive && b.exclusive) issues.push({ id: `${a.id}-${b.id}-EX`, type: '独占冲突', severity: '高', windowIds: [a.id, b.id], title: `${a.channel} 与 ${b.channel} 独占期重叠`, explanation: `同一作品在 ${a.territory} 的独占窗口重叠 ${Math.max(1, Math.ceil((Math.min(new Date(a.end).getTime(), new Date(b.end).getTime()) - Math.max(new Date(a.start).getTime(), new Date(b.start).getTime())) / 86400000))} 天，必须调整一方窗口或解除独占。` })
      else if (overlap && (a.exclusive || b.exclusive)) issues.push({ id: `${a.id}-${b.id}-NEX`, type: '独占冲突', severity: '中', windowIds: [a.id, b.id], title: `${a.exclusive ? a.channel : b.channel} 独占范围内存在非独占授权`, explanation: '独占条款优先于普通授权，需确认合同是否设置“同渠道、同语言、同区域”的例外。' })
      const earlier = order.indexOf(a.rights) < order.indexOf(b.rights) ? a : b
      const later = earlier === a ? b : a
      if (new Date(later.start) < new Date(earlier.end) && !overlap) issues.push({ id: `${a.id}-${b.id}-ORDER`, type: '窗口倒挂', severity: '高', windowIds: [a.id, b.id], title: `${later.channel} 开窗早于前置窗口结束`, explanation: '不同授权窗口出现无重叠但倒挂的情况，请复核排期并重新计算窗口优先级。' })
    }
  }
  return [...issues, ...findChainConflicts(windows)]
}

export function shiftWindow(win: LicenseWindow, days: number): LicenseWindow {
  const shift = (date: string) => { const value = new Date(date); value.setDate(value.getDate() + days); return value.toISOString().slice(0, 10) }
  return { ...win, start: shift(win.start), end: shift(win.end), status: '草案', rev: (win.rev ?? 0) + 1 }
}
