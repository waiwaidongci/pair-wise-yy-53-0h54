export type RightsType = '院线' | '电视' | '流媒体' | '航空' | '非院线'
export type Territory = '中国大陆' | '中国香港' | '中国台湾' | '新加坡' | '马来西亚' | '东南亚区域' | '北美'
export type WindowStatus = '草案' | '冲突' | '已确认' | '已失效' | '待核验'

export interface LicenseWindow {
  id: string
  workId: string
  work: string
  channel: string
  rights: RightsType
  territory: Territory
  start: string
  end: string
  exclusive: boolean
  sublicense: boolean
  priority: number
  status: WindowStatus
  /** 次级授权指向的母窗口 id；母窗口自身为 null */
  parentId?: string | null
  /** 授权链 id，与母窗口的 id 一致；独立窗口自成一链 */
  chainId?: string
  /** 修订号：母窗口调整时递增，用于并发提交的先到生效判定 */
  rev?: number
  /** 旧系统迁入的次级授权（母引用已丢失），迁移时尝试匹配母窗口 */
  legacySecondary?: boolean
  /** 迁移后仍找不到母窗口，留待人工核验 */
  needsVerification?: boolean
}

export interface RightsComment {
  id: string
  channel: string
  anchor: string
  author: string
  role: string
  content: string
  resolved: boolean
}

export interface DraftVersion {
  id: string
  author: string
  time: string
  summary: string
  changes: string[]
}
