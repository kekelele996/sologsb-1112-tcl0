/** 通报条目对账状态 */
export type RecoveryEntryStatus = 'attached' | 'pending' | 'unmatched';

/** 通报导入状态：done 已对账 / failed 导入失败（可重试） */
export type RecoveryNoticeStatus = 'done' | 'failed';

/**
 * 回收通报（上级中心发来的一段文字）。
 * 一段通报可能含多个环号，逐条解析为 RecoveryEntry 对账。
 */
export interface RecoveryNotice {
  id: string;
  /** 粘贴的通报原文 */
  rawText: string;
  /** 原文哈希（幂等：同一段通报再贴不重复挂接） */
  textHash: string;
  /** 来报站点（通报层面，可空；条目内站点优先） */
  reportSite?: string;
  /** 接收时间 ISO */
  receivedAt: string;
  /** 导入状态 */
  status: RecoveryNoticeStatus;
  /** 失败原因（status=failed 时） */
  error?: string;
  /** 条目数（列表展示用） */
  entryCount: number;
}

/**
 * 通报条目：按金属环号与本地记录逐条对账。
 * - attached：本地有初捕记录且鸟种/日期一致，已挂接一条「回收」记录
 * - pending：本地有记录但鸟种或日期对不上，待人工核实（本地记录与通报均保留）
 * - unmatched：本地查无此环号，列出等人认领
 */
export interface RecoveryEntry {
  id: string;
  noticeId: string;
  /** 通报中的金属环号 */
  ringNo: string;
  /** 通报鸟种中文名（可空） */
  speciesCn?: string;
  /** 回收日期 ISO（可空） */
  recoveryDate?: string;
  /** 来报站点（可空） */
  reportSite?: string;
  /** 对账状态 */
  status: RecoveryEntryStatus;
  /** 命中的本地记录 id（attached / pending） */
  matchedRingId?: string;
  /** 挂接生成的回收记录 id（attached） */
  attachedRingId?: string;
  /** 待核实原因（pending 时） */
  conflictReason?: string;
  /** 认领备注（unmatched，人来认领后填写） */
  claimNote?: string;
  /** 认领时间 ISO */
  claimedAt?: string;
}

/** 条目对账状态文案与配色 */
export const ENTRY_STATUS_META: Record<RecoveryEntryStatus, { label: string; type: 'success' | 'warning' | 'info' }> = {
  attached: { label: '已挂接', type: 'success' },
  pending: { label: '待核实', type: 'warning' },
  unmatched: { label: '待认领', type: 'info' },
};
