import type { RingRecord } from '../types/ring-record';
import type { RecoveryMatchStatus } from '../types/recovery';
import type { ParsedRecoveryItem } from './recovery';
import { sameDay } from './date';

export interface MatchVerdict {
  status: RecoveryMatchStatus;
  /** 对账依据 / 待核实原因 */
  discrepancy: string;
  /** 命中的本地初捕记录（已对账 / 待核实均有本地记录） */
  initial?: RingRecord;
}

/** 同环号的初捕记录（多条时取最早环志日期的一条作为挂靠基准） */
export function pickInitial(records: RingRecord[]): RingRecord | undefined {
  return records
    .filter((record) => record.status === '初捕')
    .sort((a, b) => a.ringDate.localeCompare(b.ringDate))[0];
}

/**
 * 通报条目与本地记录对账：
 * - 本地查无此环号 → 待认领；
 * - 有记录但无初捕基准 → 待核实；
 * - 鸟种或回收日期对不上 → 待核实（本地记录与通报均保持原样，由人来定）；
 * - 鸟种一致、日期为初捕当天或之后 → 已对账。
 */
export function matchRecoveryItem(item: ParsedRecoveryItem, localRings: RingRecord[]): MatchVerdict {
  const sameRing = localRings.filter(
    (record) => record.ringNo.trim().toUpperCase() === item.ringNo.trim().toUpperCase(),
  );
  if (sameRing.length === 0) {
    return { status: '待认领', discrepancy: '本地环志档案中查无此环号，等待人工认领' };
  }
  const initial = pickInitial(sameRing);
  if (!initial) {
    return { status: '待核实', discrepancy: '本地有该环号记录但没有初捕记录，无法自动挂接收回' };
  }
  const problems: string[] = [];

  if (item.speciesCn && item.speciesCn !== initial.speciesCn) {
    problems.push(`鸟种不一致（通报：${item.speciesCn}，本地初捕：${initial.speciesCn}）`);
  }
  if (!item.recoveryDate) {
    problems.push('通报中未识别到回收日期');
  } else {
    if (sameDay(item.recoveryDate, initial.ringDate) < 0) {
      problems.push('回收日期早于本地初捕日期');
    }
  }

  if (problems.length > 0) {
    return {
      status: '待核实',
      discrepancy: problems.join('；'),
      initial,
    };
  }
  return {
    status: '已对账',
    discrepancy: item.speciesCn
      ? `鸟种一致${item.recoveryDate ? '，回收日期有效' : ''}`
      : '回收日期有效（通报未注明鸟种，以本地初捕为准）',
    initial,
  };
}
