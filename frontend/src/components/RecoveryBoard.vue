<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRecoveryStore } from '../stores/recoveryStore';
import { useRingStore } from '../stores/ringStore';
import { useSiteStore } from '../stores/siteStore';
import { useSessionStore } from '../stores/sessionStore';
import { ENTRY_STATUS_META, type RecoveryEntry, type RecoveryNotice } from '../types/recovery';
import type { RingRecord } from '../types/ring-record';
import { formatDate, formatDateTime } from '../utils/format';
import { db } from '../utils/db';
import { toPlain } from '../utils/plain';

const recoveryStore = useRecoveryStore();
const ringStore = useRingStore();
const siteStore = useSiteStore();
const sessionStore = useSessionStore();

const importVisible = ref(false);
const importText = ref('');
const importing = ref(false);
const resultNotice = ref<RecoveryNotice | null>(null);
const resultEntries = ref<RecoveryEntry[]>([]);

const claimVisible = ref(false);
const claimEntry = ref<RecoveryEntry | null>(null);
const claimMode = ref<'link' | 'create' | 'note'>('link');
const claimTargetId = ref('');
const claimDate = ref('');
const claimSite = ref('');
const claimNote = ref('');

const notices = computed(() => recoveryStore.notices);

/** 本地环号去重选项（挂接目标）：每个环号取初捕记录，无初捕取最早一条 */
const ringOptions = computed(() => {
  const map = new Map<string, RingRecord>();
  ringStore.rings.forEach((r) => {
    const key = r.ringNo.toLowerCase();
    const exist = map.get(key);
    if (!exist || (r.status === '初捕' && exist.status !== '初捕') || (r.status === exist.status && r.ringDate < exist.ringDate)) {
      map.set(key, r);
    }
  });
  return Array.from(map.values()).sort((a, b) => a.ringNo.localeCompare(b.ringNo));
});

function openImport() {
  importText.value = '';
  resultNotice.value = null;
  resultEntries.value = [];
  importVisible.value = true;
}

async function doImport() {
  const text = importText.value.trim();
  if (!text) {
    ElMessage.warning('请先粘贴上级中心发来的回收通报文字');
    return;
  }
  importing.value = true;
  try {
    const { notice, duplicated, error } = await recoveryStore.importNotice(text);
    if (error) {
      ElMessage.error(`导入失败：${error}`);
      resultNotice.value = notice ?? null;
      resultEntries.value = notice ? recoveryStore.entriesOf(notice.id) : [];
      return;
    }
    if (duplicated) {
      ElMessage.info('该通报已导入过，未重复挂接');
    } else {
      ElMessage.success('通报对账完成，已按金属环号挂接回收记录');
    }
    resultNotice.value = notice ?? null;
    resultEntries.value = notice ? recoveryStore.entriesOf(notice.id) : [];
    importText.value = '';
  } finally {
    importing.value = false;
  }
}

async function retry(notice: RecoveryNotice) {
  const { error } = await recoveryStore.retryNotice(notice.id);
  if (error) {
    ElMessage.error(`重试仍失败：${error}`);
  } else {
    ElMessage.success('重试成功，已完成对账');
  }
}

function openClaim(entry: RecoveryEntry) {
  claimEntry.value = entry;
  claimMode.value = 'link';
  claimDate.value = entry.recoveryDate ? entry.recoveryDate.slice(0, 10) : '';
  claimSite.value = entry.reportSite ?? '';
  claimNote.value = entry.claimNote ?? '';
  // 默认选中同环号的本地记录（若存在）
  const same = ringStore.rings.find((r) => r.ringNo.toLowerCase() === entry.ringNo.toLowerCase());
  claimTargetId.value = same?.id ?? '';
  claimVisible.value = true;
}

async function confirmClaim() {
  const entry = claimEntry.value;
  if (!entry) return;
  const recoveryDate = claimDate.value ? new Date(`${claimDate.value}T00:00:00`).toISOString() : undefined;
  const reportSite = claimSite.value.trim() || undefined;

  if (claimMode.value === 'note') {
    await recoveryStore.markClaimed(entry.id, claimNote.value);
    ElMessage.success('已标记认领');
  } else if (claimMode.value === 'create') {
    // 新建一条初捕档案，再把回收挂上去
    const target: RingRecord = {
      id: `ring-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      ringNo: entry.ringNo,
      colorRing: '无',
      speciesCn: entry.speciesCn || '待定',
      speciesSci: '',
      age: '成',
      ringDate: recoveryDate ?? new Date().toISOString(),
      netNo: '',
      netRound: 1,
      status: '初捕',
      ringer: '待补',
      siteId: siteStore.sites[0]?.id ?? '',
      sessionId: sessionStore.sessions[0]?.id ?? '',
    };
    // 先落初捕档案并刷新，再挂接回收（claimEntry 需在本地记录中查到目标）
    await db.rings.put(toPlain(target));
    await ringStore.hydrate();
    await recoveryStore.claimEntry(entry.id, target.id, { recoveryDate, reportSite, note: claimNote.value });
    ElMessage.success('已新建初捕档案并挂接回收');
  } else {
    if (!claimTargetId.value) {
      ElMessage.warning('请选择要挂接的本地环号记录');
      return;
    }
    await recoveryStore.claimEntry(entry.id, claimTargetId.value, { recoveryDate, reportSite, note: claimNote.value });
    ElMessage.success('已挂接到本地记录');
  }
  claimVisible.value = false;
}

function entryMeta(status: RecoveryEntry['status']) {
  return ENTRY_STATUS_META[status];
}

function ringLabel(r: RingRecord): string {
  return `${r.ringNo} · ${r.speciesCn} · ${formatDate(r.ringDate)}（${r.status}）`;
}
</script>

<template>
  <el-card shadow="never" class="block recovery-card">
    <template #header>
      <div class="card-head">
        <span>回收通报对账</span>
        <span class="card-actions">
          <el-badge v-if="recoveryStore.actionNeededCount > 0" :value="recoveryStore.actionNeededCount" type="danger" class="badge">
            <el-button type="success" plain @click="openImport">导入回收通报</el-button>
          </el-badge>
          <el-button v-else type="success" plain @click="openImport">导入回收通报</el-button>
        </span>
      </div>
    </template>

    <p class="hint">
      粘贴上级中心发来的回捕通报（一段文字即可），按金属环号与本地记录对账：本地有初捕记录的自动挂接「回收」并带上来报站点与回收日期；
      鸟种或日期对不上的标为待核实（本地记录与通报都保留）；查不到环号的列出等人认领。同一段通报重复导入不会重复挂接。
    </p>

    <el-empty v-if="notices.length === 0" description="暂无回收通报，点击右上角「导入回收通报」开始对账" :image-size="80" />

    <el-collapse v-else>
      <el-collapse-item v-for="notice in notices" :key="notice.id">
        <template #title>
          <div class="notice-head">
            <el-tag size="small" :type="notice.status === 'failed' ? 'danger' : 'success'" effect="plain">
              {{ notice.status === 'failed' ? '导入失败' : '已对账' }}
            </el-tag>
            <span class="notice-time">{{ formatDateTime(notice.receivedAt) }}</span>
            <span class="notice-counts">
              <el-tag v-if="recoveryStore.entriesOf(notice.id).some((e) => e.status === 'attached')" size="small" type="success" effect="dark">
                已挂接 {{ recoveryStore.entriesOf(notice.id).filter((e) => e.status === 'attached').length }}
              </el-tag>
              <el-tag v-if="recoveryStore.entriesOf(notice.id).some((e) => e.status === 'pending')" size="small" type="warning" effect="dark">
                待核实 {{ recoveryStore.entriesOf(notice.id).filter((e) => e.status === 'pending').length }}
              </el-tag>
              <el-tag v-if="recoveryStore.entriesOf(notice.id).some((e) => e.status === 'unmatched')" size="small" type="info" effect="dark">
                待认领 {{ recoveryStore.entriesOf(notice.id).filter((e) => e.status === 'unmatched').length }}
              </el-tag>
            </span>
            <el-button v-if="notice.status === 'failed'" link type="primary" size="small" @click.stop="retry(notice)">重试</el-button>
          </div>
        </template>

        <el-alert v-if="notice.error" :title="`失败原因：${notice.error}`" type="error" :closable="false" class="error-alert" />

        <el-table :data="recoveryStore.entriesOf(notice.id)" size="small" border>
          <el-table-column prop="ringNo" label="金属环号" width="110" />
          <el-table-column label="通报鸟种" width="120">
            <template #default="scope">{{ scope.row.speciesCn ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="回收日期" width="110">
            <template #default="scope">{{ scope.row.recoveryDate ? formatDate(scope.row.recoveryDate) : '—' }}</template>
          </el-table-column>
          <el-table-column label="来报站点" min-width="140" show-overflow-tooltip>
            <template #default="scope">{{ scope.row.reportSite ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="对账状态" width="90">
            <template #default="scope">
              <el-tag :type="entryMeta(scope.row.status).type" size="small">{{ entryMeta(scope.row.status).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="说明" min-width="180" show-overflow-tooltip>
            <template #default="scope">
              <span v-if="scope.row.conflictReason" class="conflict">{{ scope.row.conflictReason }}</span>
              <span v-else-if="scope.row.claimNote" class="claim-note">认领备注：{{ scope.row.claimNote }}</span>
              <span v-else-if="scope.row.status === 'attached'" class="ok">已挂接到本地初捕记录</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="scope">
              <el-button v-if="scope.row.status === 'unmatched'" link type="primary" size="small" @click="openClaim(scope.row)">认领</el-button>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>

        <el-collapse-transition>
          <pre class="raw-text">{{ notice.rawText }}</pre>
        </el-collapse-transition>
      </el-collapse-item>
    </el-collapse>

    <!-- 导入对话框 -->
    <el-dialog v-model="importVisible" title="导入回收通报" width="720px">
      <el-input
        v-model="importText"
        type="textarea"
        :rows="10"
        placeholder="粘贴上级中心发来的回捕通报文字，例如：
环号：A-10231
鸟种：红喉歌鸲
回收日期：2026-09-15
回收地点：山东黄河口
（可一次粘贴多条，每条含金属环号即可）"
      />
      <div class="dialog-tip">提示：按金属环号与本地记录对账；同一段通报重复导入不会重复挂接。</div>

      <div v-if="resultNotice" class="result-box">
        <el-alert
          :title="resultNotice.status === 'failed' ? '导入失败，可修改后重试' : '对账完成'"
          :type="resultNotice.status === 'failed' ? 'error' : 'success'"
          :closable="false"
          class="result-alert"
        />
        <el-table :data="resultEntries" size="small" border max-height="280">
          <el-table-column prop="ringNo" label="金属环号" width="110" />
          <el-table-column label="通报鸟种" width="120">
            <template #default="scope">{{ scope.row.speciesCn ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="回收日期" width="110">
            <template #default="scope">{{ scope.row.recoveryDate ? formatDate(scope.row.recoveryDate) : '—' }}</template>
          </el-table-column>
          <el-table-column label="来报站点" min-width="140" show-overflow-tooltip>
            <template #default="scope">{{ scope.row.reportSite ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="scope">
              <el-tag :type="entryMeta(scope.row.status).type" size="small">{{ entryMeta(scope.row.status).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="说明" min-width="160" show-overflow-tooltip>
            <template #default="scope">
              <span v-if="scope.row.conflictReason" class="conflict">{{ scope.row.conflictReason }}</span>
              <span v-else-if="scope.row.status === 'attached'" class="ok">已挂接</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <template #footer>
        <el-button @click="importVisible = false">关闭</el-button>
        <el-button type="primary" :loading="importing" @click="doImport">开始对账</el-button>
      </template>
    </el-dialog>

    <!-- 认领对话框 -->
    <el-dialog v-model="claimVisible" title="认领待认领环号" width="560px">
      <el-descriptions :column="1" border class="claim-desc">
        <el-descriptions-item label="通报金属环号">{{ claimEntry?.ringNo }}</el-descriptions-item>
        <el-descriptions-item label="通报鸟种">{{ claimEntry?.speciesCn ?? '—' }}</el-descriptions-item>
      </el-descriptions>

      <el-radio-group v-model="claimMode" class="claim-modes">
        <el-radio value="link">挂接到已有本地记录</el-radio>
        <el-radio value="create">新建初捕档案并挂接</el-radio>
        <el-radio value="note">仅标记已知悉</el-radio>
      </el-radio-group>

      <el-form label-width="110px" class="claim-form">
        <el-form-item v-if="claimMode === 'link'" label="本地环号记录">
          <el-select v-model="claimTargetId" filterable placeholder="选择要挂接的本地记录" style="width: 100%">
            <el-option v-for="r in ringOptions" :key="r.id" :label="ringLabel(r)" :value="r.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="回收日期">
          <el-date-picker v-model="claimDate" type="date" value-format="YYYY-MM-DD" placeholder="回收日期" style="width: 100%" />
        </el-form-item>
        <el-form-item label="来报站点">
          <el-input v-model="claimSite" placeholder="上级中心通报的回收地点" maxlength="40" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="claimNote" type="textarea" :rows="2" placeholder="认领说明（选填）" maxlength="80" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="claimVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmClaim">确认认领</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.recovery-card {
  margin-bottom: 16px;
  border-radius: 8px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.badge :deep(.el-badge__content) {
  right: 4px;
  top: 4px;
}
.hint {
  margin: 0 0 12px;
  color: #6f8480;
  font-size: 13px;
  line-height: 1.6;
}
.notice-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.notice-time {
  color: #6f8480;
  font-size: 13px;
}
.notice-counts {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.error-alert {
  margin-bottom: 10px;
}
.raw-text {
  margin: 10px 0 0;
  padding: 10px;
  background: #f6f9f8;
  border: 1px solid #dbe7e2;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: #3a5a52;
  max-height: 240px;
  overflow: auto;
}
.dialog-tip {
  margin-top: 8px;
  color: #8a99a5;
  font-size: 12px;
}
.result-box {
  margin-top: 12px;
}
.result-alert {
  margin-bottom: 10px;
}
.conflict {
  color: #e6a23c;
}
.ok {
  color: #67c23a;
}
.muted {
  color: #b0b8c1;
}
.claim-note {
  color: #909399;
}
.claim-desc {
  margin-bottom: 12px;
}
.claim-modes {
  margin-bottom: 12px;
}
.claim-form {
  margin-top: 4px;
}
</style>
