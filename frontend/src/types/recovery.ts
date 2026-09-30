/** 回捕通报条目对账状态 */
export type RecoveryMatchStatus = '待认领' | '待核实' | '已对账';

/** 上级中心回捕通报解析出的单个环号条目（落库） */
export interface RecoveryReport {
  id: string;
  /** 整段通报归一化后的指纹，同段通报重复粘贴用于去重 */
  sourceHash: string;
  /** 整段通报原文 */
  sourceText: string;
  /** 金属环号 */
  ringNo: string;
  /** 通报中的鸟种中文名（可能解析不到，为空串） */
  speciesCn: string;
  /** 通报中的回收日期 ISO（解析不到为空串） */
  recoveryDate: string;
  /** 上报站点 */
  reportSite: string;
  /** 该环号所在原文片段 */
  snippet: string;
  /** 对账状态 */
  status: RecoveryMatchStatus;
  /** 待核实 / 待认领原因，或人工处理说明 */
  discrepancy: string;
  /** 挂接生成（或已存在）的回收环志记录 id */
  ringId: string;
  importedAt: string;
  resolvedAt: string;
  /** 自动对账 / 人工认领 / 人工确认 */
  resolvedBy: string;
}

export const RECOVERY_STATUS_COLOR: Record<RecoveryMatchStatus, 'info' | 'warning' | 'success'> = {
  待认领: 'info',
  待核实: 'warning',
  已对账: 'success',
};

export const RECOVERY_STATUSES: RecoveryMatchStatus[] = ['待认领', '待核实', '已对账'];
