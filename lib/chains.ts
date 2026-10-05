import type {
  ChainConclusion,
  ConstraintViolation,
  LicenseChain,
  LicenseWindow,
  SublicenseNode,
  SublicenseStatus,
  Territory,
} from './types'

/** 地区层级：东南亚区域包含新加坡、马来西亚；其余地区仅自身等于自身 */
const territoryContainsMap: Partial<Record<Territory, Territory[]>> = {
  东南亚区域: ['东南亚区域', '新加坡', '马来西亚'],
}

export function territoryContains(parent: Territory, child: Territory): boolean {
  if (parent === child) return true
  return territoryContainsMap[parent]?.includes(child) ?? false
}

function day(value: string): number {
  return new Date(`${value}T00:00:00`).getTime()
}

export function dateWithin(parent: LicenseWindow, start: string, end: string): boolean {
  return day(start) >= day(parent.start) && day(end) <= day(parent.end)
}

/** 核验次级窗口是否落在母窗口的日期、地区、独占边界内 */
export function checkSubAgainstParent(parent: LicenseWindow | undefined, sub: SublicenseNode): ConstraintViolation {
  const violations: ConstraintViolation = {}
  if (!parent || parent.id !== sub.parentWindowId) return violations
  if (day(sub.start) < day(parent.start) || day(sub.end) > day(parent.end)) {
    violations.date = `次级窗口 ${sub.start} ~ ${sub.end} 超出母窗口 ${parent.start} ~ ${parent.end}`
  }
  if (!territoryContains(parent.territory, sub.territory)) {
    violations.territory = `次级地区「${sub.territory}」不在母窗口地区「${parent.territory}」范围内`
  }
  if (sub.exclusive && !parent.exclusive) {
    violations.exclusive = '母窗口为非独占授权，次级窗口不得登记为独占'
  }
  return violations
}

export function hasViolation(violations: ConstraintViolation): boolean {
  return Boolean(violations.date || violations.territory || violations.exclusive)
}

/**
 * 依据母窗口当前状态推导次级节点状态。
 * - 母窗口引用为空/找不到 → 待核验（存量数据对不上时走这里）
 * - 母窗口关闭转授权 → 整链失效（最高优先级）
 * - 并发后到保留的草稿保持粘性：即便日期/地区已越界，也维持“草稿-冲突”，
 *   由用户看清冲突后显式重新提交或放弃，避免母窗口每次变动都被静默改写
 * - 日期/地区/独占越界 → 立即失效
 */
export function deriveSubStatus(
  child: SublicenseNode,
  parent: LicenseWindow | undefined,
): SublicenseStatus {
  if (child.parentWindowId === null || !parent) return '待核验'
  if (!parent.sublicense) return '已失效-母窗口关闭转授权'
  if (child.status === '草稿-冲突') return '草稿-冲突'
  if (hasViolation(checkSubAgainstParent(parent, child))) return '已失效-超出母窗口'
  return '生效中'
}

/** 母窗口变化后重新核验整条链：越界的次级窗口立刻失效，重新被包含的可恢复生效 */
export function reconcileChildren(windows: LicenseWindow[], children: SublicenseNode[]): SublicenseNode[] {
  return children.map((child) => {
    const parent = child.parentWindowId ? windows.find((item) => item.id === child.parentWindowId) : undefined
    return { ...child, violations: checkSubAgainstParent(parent, child), status: deriveSubStatus(child, parent) }
  })
}

/**
 * 组装授权链：只补算越界事实（violations）用于展示，状态沿用权威值。
 * 状态的重新判定只在写入点通过 reconcileChildren 发生；这里若再次推导，
 * 会把并发后到的粘性「草稿-冲突」静默改写成失效。
 */
function attachChainFacts(windows: LicenseWindow[], childrenInput: SublicenseNode[]): SublicenseNode[] {
  return childrenInput.map((child) => {
    const parent = child.parentWindowId ? windows.find((item) => item.id === child.parentWindowId) : undefined
    return { ...child, violations: checkSubAgainstParent(parent, child) }
  })
}

/** 把母窗口、次级窗口串成授权链并汇总结论 */
export function buildChains(windows: LicenseWindow[], childrenInput: SublicenseNode[]): LicenseChain[] {
  const children = attachChainFacts(windows, childrenInput)
  const parentIds = new Set<string>([
    ...windows.filter((item) => item.sublicense).map((item) => item.id),
    ...children.filter((item) => item.parentWindowId).map((item) => item.parentWindowId as string),
  ])
  return [...parentIds].map((parentId) => {
    const parent = windows.find((item) => item.id === parentId)
    if (!parent) return undefined
    const linked = children.filter((item) => item.parentWindowId === parentId)
    const activeCount = linked.filter((item) => item.status === '生效中').length
    const invalidCount = linked.filter((item) => item.status.startsWith('已失效')).length
    const reviewCount = linked.filter((item) => item.status === '待核验').length
    const draftCount = linked.filter((item) => item.status === '草稿-冲突').length
    let conclusion: ChainConclusion
    if (!parent.sublicense) conclusion = '整链失效'
    else if (reviewCount > 0 && activeCount === 0 && invalidCount === 0) conclusion = '待核验'
    else if (invalidCount > 0) conclusion = '部分次级失效'
    else conclusion = '有效'
    return { parent, children: linked, activeCount, invalidCount, reviewCount, draftCount, conclusion }
  }).filter((item): item is LicenseChain => Boolean(item))
}

/** 待核验的游离节点（对不上母窗口的存量次级登记） */
export function orphanChildren(children: SublicenseNode[]): SublicenseNode[] {
  return children.filter((item) => item.parentWindowId === null || item.status === '待核验')
}

export interface MigrationResult {
  children: SublicenseNode[]
  matchedCount: number
  reviewCount: number
}

/**
 * 存量数据迁移：没有母窗口引用的次级登记，按作品、权利类型、转授权开关、
 * 日期/地区/独占边界自动寻找唯一母窗口；对不上（找不到或命中多个）的保留为待核验。
 */
export function migrateLegacy(windows: LicenseWindow[], children: SublicenseNode[]): MigrationResult {
  let matchedCount = 0
  const migrated = children.map((child) => {
    if (child.parentWindowId !== null && child.parentWindowId !== undefined) return child
    const candidates = windows.filter((parent) => {
      if (parent.workId !== child.workId || parent.rights !== child.rights || !parent.sublicense) return false
      const probe = { ...child, parentWindowId: parent.id }
      return !hasViolation(checkSubAgainstParent(parent, probe))
    })
    if (candidates.length === 1) {
      const parent = candidates[0]!
      matchedCount += 1
      const linked: SublicenseNode = { ...child, parentWindowId: parent.id, basedOnRevision: parent.revision }
      return { ...linked, violations: checkSubAgainstParent(parent, linked), status: deriveSubStatus(linked, parent) }
    }
    // 找不到或命中多个母窗口 → 留待核验，并记录线索
    const sameWork = windows.filter((parent) => parent.workId === child.workId)
    const note = candidates.length > 1
      ? `命中 ${candidates.length} 个候选母窗口（${candidates.map((item) => item.id).join('、')}），需人工核验归属`
      : sameWork.length === 0
        ? `作品 ${child.workId} 下找不到任何母窗口，数据来源待核验`
        : `作品 ${child.work} 现有母窗口均无法覆盖其日期/地区/独占范围，留待核验`
    return { ...child, parentWindowId: null, status: '待核验' as const, note: child.note ? `${child.note}；${note}` : note }
  })
  return { children: migrated, matchedCount, reviewCount: migrated.filter((item) => item.status === '待核验').length }
}

/** 登记新次级窗口前的硬校验：母窗口必须开着转授权，且日期/地区/独占不得越界 */
export function validateRegistration(
  parent: LicenseWindow | undefined,
  sub: SublicenseNode,
): { ok: boolean; message: string } {
  if (!parent) return { ok: false, message: '母窗口不存在，无法登记次级授权。' }
  if (!parent.sublicense) return { ok: false, message: `母窗口 ${parent.id} 未开启转授权，不能登记次级窗口。` }
  if (day(sub.end) < day(sub.start)) return { ok: false, message: '次级窗口结束日期不能早于开始日期。' }
  const violations = checkSubAgainstParent(parent, sub)
  if (violations.date) return { ok: false, message: violations.date }
  if (violations.territory) return { ok: false, message: violations.territory }
  if (violations.exclusive) return { ok: false, message: violations.exclusive }
  return { ok: true, message: '次级窗口在母窗口范围内，可以登记。' }
}
