import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain, toPlainList } from '../utils/plain';
import { parseRecoveryNotice, type ParsedEntry } from '../utils/recoveryParser';
import { formatDate } from '../utils/format';
import type { RingRecord } from '../types/ring-record';
import type { RecoveryEntry, RecoveryNotice } from '../types/recovery';
import { useRingStore } from './ringStore';

interface RecoveryState {
  notices: RecoveryNotice[];
  entries: RecoveryEntry[];
  hydrated: boolean;
}

/** djb2 同步哈希：同一段通报原文 → 同一哈希，用于幂等去重 */
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return `h${h.toString(36)}`;
}

/** 依据通报条目 + 命中的本地初捕记录，构造一条「回收」记录 */
function buildAttachedRing(entry: { ringNo: string; speciesCn?: string; recoveryDate?: string; reportSite?: string }, target: RingRecord, noticeId: string): RingRecord {
  return {
    id: uid('ring'),
    ringNo: target.ringNo,
    colorRing: target.colorRing,
    speciesCn: target.speciesCn,
    speciesSci: target.speciesSci,
    age: target.age,
    ringDate: entry.recoveryDate ?? new Date().toISOString(),
    netNo: target.netNo,
    netRound: target.netRound,
    status: '回收',
    ringer: target.ringer,
    siteId: target.siteId,
    sessionId: target.sessionId,
    reportSite: entry.reportSite || undefined,
    recoveryOf: target.id,
    noticeId,
    remark: `回收通报挂接${entry.reportSite ? `（来报站点：${entry.reportSite}）` : ''}`,
  };
}

interface ReconciledEntry {
  status: RecoveryEntry['status'];
  matchedRingId?: string;
  attachedRing?: RingRecord;
  conflictReason?: string;
}

/** 逐条对账：本地查无此环 → unmatched；鸟种/日期冲突或缺回收日期 → pending；否则 attached */
function reconcileEntry(parsed: ParsedEntry, localRings: RingRecord[], noticeId: string): ReconciledEntry {
  const ringNo = parsed.ringNo.trim();
  const matches = localRings.filter((r) => r.ringNo.toLowerCase() === ringNo.toLowerCase());
  if (matches.length === 0) {
    return { status: 'unmatched' };
  }
  const firstCapture = matches
    .filter((r) => r.status === '初捕')
    .sort((a, b) => a.ringDate.localeCompare(b.ringDate))[0];
  const target = firstCapture ?? [...matches].sort((a, b) => a.ringDate.localeCompare(b.ringDate))[0];

  const reasons: string[] = [];
  if (parsed.speciesCn && parsed.speciesCn !== target.speciesCn) {
    reasons.push(`通报鸟种「${parsed.speciesCn}」与本地「${target.speciesCn}」不一致`);
  }
  if (parsed.recoveryDate) {
    const rec = new Date(parsed.recoveryDate).getTime();
    const ring = new Date(target.ringDate).getTime();
    if (rec < ring) {
      reasons.push(`回收日期 ${formatDate(parsed.recoveryDate)} 早于本地环志日期 ${formatDate(target.ringDate)}`);
    }
  } else {
    reasons.push('通报未提供回收日期');
  }
  if (!firstCapture) {
    reasons.push('本地无该环号的初捕记录');
  }

  if (reasons.length > 0) {
    return { status: 'pending', matchedRingId: target.id, conflictReason: reasons.join('；') };
  }
  return {
    status: 'attached',
    matchedRingId: target.id,
    attachedRing: buildAttachedRing(parsed, target, noticeId),
  };
}

export const useRecoveryStore = defineStore('recovery', {
  state: (): RecoveryState => ({ notices: [], entries: [], hydrated: false }),

  getters: {
    /** 某通报的全部条目（按状态排序：待核实 → 待认领 → 已挂接） */
    entriesOf(state) {
      return (noticeId: string): RecoveryEntry[] =>
        state.entries
          .filter((e) => e.noticeId === noticeId)
          .sort((a, b) => {
            const order = { pending: 0, unmatched: 1, attached: 2 } as const;
            return order[a.status] - order[b.status];
          });
    },
    /** 待核实条目数（需要人工定夺） */
    pendingCount(state): number {
      return state.entries.filter((e) => e.status === 'pending').length;
    },
    /** 待认领条目数（查无此环号，尚未认领） */
    unmatchedCount(state): number {
      return state.entries.filter((e) => e.status === 'unmatched' && !e.claimedAt).length;
    },
    /** 需要处理的条目总数 */
    actionNeededCount(state): number {
      return state.entries.filter((e) => e.status === 'pending' || (e.status === 'unmatched' && !e.claimedAt)).length;
    },
  },

  actions: {
    async hydrate() {
      const [notices, entries] = await Promise.all([
        db.recoveryNotices.orderBy('receivedAt').reverse().toArray(),
        db.recoveryEntries.toArray(),
      ]);
      this.notices = notices;
      this.entries = entries;
      this.hydrated = true;
    },

    /**
     * 导入一段通报文字并对账。
     * - 同一段通报（同哈希）已成功导入 → 直接返回，不重复挂接
     * - 解析失败 → 通报落为 failed（原文 + 错误原因），不写任何环记录，可重试
     * - 对账与挂接在一个事务内：要么全部落库，要么全部回滚
     */
    async importNotice(rawText: string): Promise<{ notice?: RecoveryNotice; duplicated?: boolean; error?: string }> {
      const text = rawText.trim();
      if (!text) return { error: '通报内容为空' };

      const ringStore = useRingStore();
      const hash = hashText(text);
      const existing = this.notices.find((n) => n.textHash === hash);
      if (existing && existing.status === 'done') {
        return { notice: existing, duplicated: true };
      }

      // 1) 解析（纯计算，无写入）；失败则落 failed 通报
      let parsed;
      try {
        parsed = parseRecoveryNotice(text);
      } catch (e) {
        const notice: RecoveryNotice = {
          id: existing?.id ?? uid('notice'),
          rawText: text,
          textHash: hash,
          reportSite: existing?.reportSite,
          receivedAt: existing?.receivedAt ?? new Date().toISOString(),
          status: 'failed',
          error: (e as Error).message,
          entryCount: 0,
        };
        await db.recoveryNotices.put(toPlain(notice));
        this.upsertNotice(notice);
        return { notice, error: notice.error };
      }

      // 2) 逐条对账（纯计算）；同一段通报内同一环号只挂一次
      const seen = new Set<string>();
      const uniqueEntries = parsed.entries.filter((p) => {
        const key = p.ringNo.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const noticeId = existing?.id ?? uid('notice');
      const reconciled = uniqueEntries.map((p) => reconcileEntry(p, ringStore.rings, noticeId));

      const notice: RecoveryNotice = {
        id: noticeId,
        rawText: text,
        textHash: hash,
        reportSite: parsed.reportSite,
        receivedAt: existing?.receivedAt ?? new Date().toISOString(),
        status: 'done',
        entryCount: uniqueEntries.length,
      };
      const entries: RecoveryEntry[] = uniqueEntries.map((p, i) => ({
        id: uid('entry'),
        noticeId,
        ringNo: p.ringNo,
        speciesCn: p.speciesCn,
        recoveryDate: p.recoveryDate,
        reportSite: p.reportSite ?? parsed.reportSite,
        status: reconciled[i].status,
        matchedRingId: reconciled[i].matchedRingId,
        attachedRingId: reconciled[i].attachedRing?.id,
        conflictReason: reconciled[i].conflictReason,
      }));
      const attachedRings = reconciled.map((r) => r.attachedRing).filter((r): r is RingRecord => !!r);

      // 3) 事务内落库：通报 + 条目 + 挂接的回收记录；任一失败整体回滚
      await db.transaction('rw', db.recoveryNotices, db.recoveryEntries, db.rings, async () => {
        await db.recoveryNotices.put(toPlain(notice));
        if (existing) {
          await db.recoveryEntries.where('noticeId').equals(noticeId).delete();
        }
        await db.recoveryEntries.bulkPut(toPlainList(entries));
        if (attachedRings.length > 0) {
          await db.rings.bulkPut(toPlainList(attachedRings));
        }
      });

      this.upsertNotice(notice);
      this.entries = this.entries.filter((e) => e.noticeId !== noticeId).concat(entries);
      // 刷新环记录，让挂接的「回收」立即出现在环志列表
      await ringStore.hydrate();

      return { notice };
    },

    /** 重试失败的通报：用同一原文重新走导入流程（复用原通报行） */
    async retryNotice(noticeId: string): Promise<{ notice?: RecoveryNotice; error?: string }> {
      const notice = this.notices.find((n) => n.id === noticeId);
      if (!notice) return { error: '通报不存在' };
      return this.importNotice(notice.rawText);
    },

    /**
     * 认领一条待认领条目：挂接到指定的本地环号记录（生成一条「回收」记录）。
     * targetRingId 为本地记录 id；可覆盖通报中的回收日期与来报站点。
     */
    async claimEntry(entryId: string, targetRingId: string, patch: { recoveryDate?: string; reportSite?: string; note?: string }): Promise<void> {
      const entry = this.entries.find((e) => e.id === entryId);
      if (!entry || entry.status !== 'unmatched') return;
      const ringStore = useRingStore();
      const target = ringStore.rings.find((r) => r.id === targetRingId);
      if (!target) return;

      const attached = buildAttachedRing(
        { ringNo: entry.ringNo, speciesCn: entry.speciesCn, recoveryDate: patch.recoveryDate ?? entry.recoveryDate, reportSite: patch.reportSite ?? entry.reportSite },
        target,
        entry.noticeId,
      );
      const next: RecoveryEntry = {
        ...entry,
        status: 'attached',
        matchedRingId: target.id,
        attachedRingId: attached.id,
        claimNote: patch.note?.trim() || entry.claimNote,
        claimedAt: new Date().toISOString(),
      };

      await db.transaction('rw', db.recoveryEntries, db.rings, async () => {
        await db.recoveryEntries.put(toPlain(next));
        await db.rings.put(toPlain(attached));
      });

      this.entries = this.entries.map((e) => (e.id === entryId ? next : e));
      await ringStore.hydrate();
    },

    /** 仅标记认领（不挂接）：人已线下处理，留个备注 */
    async markClaimed(entryId: string, note: string): Promise<void> {
      const entry = this.entries.find((e) => e.id === entryId);
      if (!entry || entry.status !== 'unmatched') return;
      const next: RecoveryEntry = {
        ...entry,
        claimNote: note.trim() || '已线下认领',
        claimedAt: new Date().toISOString(),
      };
      await db.recoveryEntries.put(toPlain(next));
      this.entries = this.entries.map((e) => (e.id === entryId ? next : e));
    },

    upsertNotice(notice: RecoveryNotice) {
      const idx = this.notices.findIndex((n) => n.id === notice.id);
      if (idx >= 0) this.notices = this.notices.map((n) => (n.id === notice.id ? notice : n));
      else this.notices = [notice, ...this.notices];
    },
  },
});
