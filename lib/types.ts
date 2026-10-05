export type RightsType = '院线' | '电视' | '流媒体' | '航空' | '非院线'
export type Territory = '中国大陆' | '中国香港' | '中国台湾' | '新加坡' | '马来西亚' | '东南亚区域' | '北美'

export type WindowStatus = '草案' | '冲突' | '已确认'

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
  /** 乐观锁版本：授权链版本，母窗口调整或次级登记生效后 +1，用于并发“先到生效”判定 */
  revision: number
}

export type SublicenseStatus =
  | '生效中'
  | '已失效-超出母窗口'
  | '已失效-母窗口关闭转授权'
  | '待核验'
  | '草稿-冲突'

export type ChainConclusion =
  | '有效'
  | '部分次级失效'
  | '整链失效'
  | '待核验'

export interface ConstraintViolation {
  /** 日期/地区/独占 三类硬约束的越界描述 */
  date?: string
  territory?: string
  exclusive?: string
}

/**
 * 次级授权：挂在母窗口下的下游登记。
 * 有 parentWindowId 的是授权链内节点；存量导入对不上母窗口的节点 id 以 LEGACY- 前缀保留，
 * parentWindowId 为 null、status 为“待核验”。
 */
export interface SublicenseNode {
  id: string
  parentWindowId: string | null
  workId: string
  work: string
  subChannel: string
  rights: RightsType
  territory: Territory
  start: string
  end: string
  /** 次级窗口自身是否独占：母窗口非独占时次级不得独占 */
  exclusive: boolean
  note: string
  status: SublicenseStatus
  /** 最新一次约束核验结论，便于界面直接展示越界原因 */
  violations: ConstraintViolation
  /** 并发冲突后保留为草稿时的说明（后到方专用） */
  draftReason?: string
  /** 登记/最近一次生效时所基于的母窗口版本 */
  basedOnRevision?: number
}

export interface LicenseChain {
  parent: LicenseWindow
  children: SublicenseNode[]
  activeCount: number
  invalidCount: number
  reviewCount: number
  draftCount: number
  conclusion: ChainConclusion
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

/** 并发“后到留草稿”的提交记录（服务端） */
export interface PendingDraft {
  id: string
  kind: 'adjust' | 'register'
  parentWindowId: string
  author: string
  arrivedAt: string
  arrivedOrder: number
  expectedRevision: number
  currentRevision: number
  payload: Record<string, unknown>
  conflict: string
  /** 登记类草稿挂在授权链上的节点 id，重新提交成功后据此精确移除 */
  nodeId?: string
}

/** 并发演练里单笔提交的处理结果 */
export interface RaceSubmitResult {
  kind: 'adjust' | 'register'
  author: string
  arrivedOrder: number
  expectedRevision: number
  applied: boolean
  message: string
  nodeId?: string
  draftId?: string
  currentRevision: number
}

export interface RaceResult {
  winner: RaceSubmitResult
  loser: RaceSubmitResult
  newRevision: number
}
