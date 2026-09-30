import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain, toPlainList } from '../utils/plain';
import { sameDay } from '../utils/date';
import type { RingRecord } from '../types/ring-record';
import type { RecoveryMatchStatus, RecoveryReport } from '../types/recovery';
import { parseBulletin, sourceFingerprint, type ParsedRecoveryItem } from '../utils/recovery';
import { matchRecoveryItem } from '../utils/reconcile';

export interface ImportSummary {
  /** 与已导入通报完全重复，未写入任何数据 */
  duplicated: boolean;
  total: number;
  matched: number;
  verify: number;
  unclaimed: number;
  /** 本次新生成的回收环志记录数 */
  createdRings: number;
  reports: RecoveryReport[];
}

interface ReportState {
  reports: RecoveryReport[];
  hydrated: boolean;
}

/** 同环号、同日是否已有回收记录（跨通报重报时复用，不重复挂） */
function findRecoveryOn(rings: RingRecord[], ringNo: string, dateIso: string): RingRecord | undefined {
  return rings.find(
    (record) =>
      record.status === '回收' &&
      record.ringNo.trim().toUpperCase() === ringNo.trim().toUpperCase() &&
      !!dateIso &&
      sameDay(record.ringDate, dateIso) === 0,
  );
}

/** 依据本地初捕记录与通报条目生成一条回收环志记录（挂到初捕所在鸟点） */
function buildRecoveryRecord(initial: RingRecord, item: ParsedRecoveryItem, reportId: string): RingRecord {
  return {
    id: uid('ring'),
    ringNo: initial.ringNo,
    colorRing: initial.colorRing || '无',
    speciesCn: initial.speciesCn,
    speciesSci: initial.speciesSci,
    age: initial.age,
    ringDate: item.recoveryDate || initial.ringDate,
    netNo: '回捕通报',
    netRound: 0,
    status: '回收',
    ringer: '回捕通报',
    siteId: initial.siteId,
    sessionId: '',
    remark: `回捕通报挂接：${item.reportSite || '上报站点不详'}${item.speciesCn ? `（通报鸟种：${item.speciesCn}）` : ''}`,
    reportSite: item.reportSite,
    reportId,
  };
}

/** 回捕通报与对账结果 */
export const useReportStore = defineStore('report', {
  state: (): ReportState => ({ reports: [], hydrated: false }),

  getters: {
    byStatus(state): Record<RecoveryMatchStatus, RecoveryReport[]> {
      const groups: Record<RecoveryMatchStatus, RecoveryReport[]> = { 待认领: [], 待核实: [], 已对账: [] };
      state.reports.forEach((report) => groups[report.status].push(report));
      return groups;
    },
    pendingCount(): number {
      return this.byStatus.待认领.length + this.byStatus.待核实.length;
    },
  },

  actions: {
    async hydrate() {
      this.reports = await db.reports.orderBy('importedAt').reverse().toArray();
      this.hydrated = true;
    },

    /**
     * 导入一段通报：解析 → 指纹去重 → 与本地记录对账 → 写通报条目 + 挂接收回记录。
     * 解析失败在开事务前抛错；事务内任一步失败整体回滚，本地记录与已对好的结果均不动。
     */
    async importBulletin(text: string): Promise<ImportSummary> {
      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error('通报内容为空，请粘贴上级中心发来的通报原文');
      }
      // 先解析：解析不出来直接抛错，不动任何数据，用户改完可重试
      const items = parseBulletin(trimmed);
      const hash = sourceFingerprint(trimmed);
      const normalized = trimmed.replace(/\s+/g, '');

      const summary: ImportSummary = {
        duplicated: false,
        total: items.length,
        matched: 0,
        verify: 0,
        unclaimed: 0,
        createdRings: 0,
        reports: [],
      };

      await db.transaction('rw', db.reports, db.rings, async () => {
        // 同一段通报再贴一次：指纹（含原文比对）命中即整段跳过，不重复挂
        const existed = await db.reports.where('sourceHash').equals(hash).first();
        if (existed && existed.sourceText.replace(/\s+/g, '') === normalized) {
          summary.duplicated = true;
          summary.total = 0;
          return;
        }

        // 事务开始时的本地快照；新生成的回收记录也并入，供后续条目判重
        const rings = await db.rings.toArray();
        const importedAt = new Date().toISOString();
        const reportsToPut: RecoveryReport[] = [];
        const ringsToPut: RingRecord[] = [];

        items.forEach((item) => {
          const reportId = uid('report');
          const verdict = matchRecoveryItem(item, rings);
          let ringId = '';
          let note = verdict.discrepancy;

          if (verdict.status === '已对账' && verdict.initial) {
            const already = findRecoveryOn(rings, item.ringNo, item.recoveryDate);
            if (already) {
              // 跨通报重报（不同通报里同一环号、同一天）：关联既有回收记录，不重复生成
              ringId = already.id;
              note = `${verdict.discrepancy}（已关联既有回收记录，未重复生成）`;
            } else {
              const record = buildRecoveryRecord(verdict.initial, item, reportId);
              rings.push(record);
              ringsToPut.push(record);
              ringId = record.id;
            }
          }

          const report: RecoveryReport = {
            id: reportId,
            sourceHash: hash,
            sourceText: trimmed,
            ringNo: item.ringNo,
            speciesCn: item.speciesCn,
            recoveryDate: item.recoveryDate,
            reportSite: item.reportSite,
            snippet: item.snippet,
            status: verdict.status,
            discrepancy: note,
            ringId,
            importedAt,
            resolvedAt: verdict.status === '已对账' ? importedAt : '',
            resolvedBy: verdict.status === '已对账' ? '自动对账' : '',
          };
          reportsToPut.push(report);

          if (verdict.status === '已对账') summary.matched += 1;
          else if (verdict.status === '待核实') summary.verify += 1;
          else summary.unclaimed += 1;
        });

        summary.createdRings = ringsToPut.length;
        await db.reports.bulkPut(toPlainList(reportsToPut));
        if (ringsToPut.length > 0) {
          await db.rings.bulkPut(toPlainList(ringsToPut));
        }
        summary.reports = reportsToPut;
      });

      if (!summary.duplicated) {
        this.reports = [...summary.reports, ...this.reports];
      }
      return summary;
    },

    /**
     * 人工认领（待认领）/ 人工确认（待核实）：挂到指定的本地初捕记录上。
     * 鸟种 / 日期对不上也以人工选择为准，原通报信息保留在 discrepancy 中备查。
     */
    async attach(reportId: string, initialId: string): Promise<void> {
      await db.transaction('rw', db.reports, db.rings, async () => {
        const report = await db.reports.get(reportId);
        const initial = await db.rings.get(initialId);
        if (!report) throw new Error('通报条目不存在或已被删除');
        if (!initial || initial.status !== '初捕') {
          throw new Error('请选择一条本地初捕记录作为挂接基准');
        }

        const rings = await db.rings.toArray();
        const item: ParsedRecoveryItem = {
          ringNo: report.ringNo,
          speciesCn: report.speciesCn,
          recoveryDate: report.recoveryDate,
          reportSite: report.reportSite,
          snippet: report.snippet,
        };
        let record = findRecoveryOn(rings, initial.ringNo, report.recoveryDate);
        if (!record) {
          record = buildRecoveryRecord(initial, item, report.id);
          await db.rings.put(toPlain(record));
        }

        const manualNote =
          report.status === '待核实' && report.discrepancy
            ? `人工确认挂接（${initial.ringNo} · ${initial.speciesCn}）；原提示：${report.discrepancy}`
            : `人工认领到 ${initial.ringNo}（${initial.speciesCn}）`;
        const next: RecoveryReport = {
          ...report,
          status: '已对账',
          discrepancy: manualNote,
          ringId: record.id,
          resolvedAt: new Date().toISOString(),
          resolvedBy: report.status === '待认领' ? '人工认领' : '人工确认',
        };
        await db.reports.put(toPlain(next));
      });
      await this.hydrate();
    },

    /**
     * 用最新本地记录重新对一条 / 全部未结通报对账。
     * 新登记初捕后，待认领可自动转已对账；原本能对上的不会退回。
     */
    async recheck(ids?: string[]): Promise<{ matched: number }> {
      let matched = 0;
      await db.transaction('rw', db.reports, db.rings, async () => {
        const rings = await db.rings.toArray();
        const targets = (await db.reports.toArray()).filter(
          (report) => report.status !== '已对账' && (ids ? ids.includes(report.id) : true),
        );
        const nowIso = new Date().toISOString();
        const reportsToPut: RecoveryReport[] = [];
        const ringsToPut: RingRecord[] = [];
        const workingRings = [...rings];

        for (const report of targets) {
          const item: ParsedRecoveryItem = {
            ringNo: report.ringNo,
            speciesCn: report.speciesCn,
            recoveryDate: report.recoveryDate,
            reportSite: report.reportSite,
            snippet: report.snippet,
          };
          const verdict = matchRecoveryItem(item, workingRings);
          if (verdict.status !== '已对账' || !verdict.initial) continue;

          let record = findRecoveryOn(workingRings, item.ringNo, item.recoveryDate);
          if (!record) {
            record = buildRecoveryRecord(verdict.initial, item, report.id);
            workingRings.push(record);
            ringsToPut.push(record);
          }
          reportsToPut.push({
            ...report,
            status: '已对账',
            discrepancy: `重新对账自动挂接：${verdict.discrepancy}`,
            ringId: record.id,
            resolvedAt: nowIso,
            resolvedBy: '自动对账',
          });
          matched += 1;
        }

        if (reportsToPut.length > 0) await db.reports.bulkPut(toPlainList(reportsToPut));
        if (ringsToPut.length > 0) await db.rings.bulkPut(toPlainList(ringsToPut));
      });
      if (matched > 0) await this.hydrate();
      return { matched };
    },

    /** 删除通报条目，并一并删除由它自动生成 / 人工挂接的回收环志记录 */
    async removeReport(reportId: string): Promise<number> {
      let removedRings = 0;
      await db.transaction('rw', db.reports, db.rings, async () => {
        const linked = await db.rings.where('reportId').equals(reportId).toArray();
        removedRings = linked.length;
        await db.rings.bulkDelete(linked.map((record) => record.id));
        await db.reports.delete(reportId);
      });
      this.reports = this.reports.filter((report) => report.id !== reportId);
      return removedRings;
    },
  },
});
