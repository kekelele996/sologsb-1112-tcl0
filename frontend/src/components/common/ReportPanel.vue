<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Upload, RefreshRight, View } from '@element-plus/icons-vue';
import EmptyPanel from './EmptyPanel.vue';
import { useReportStore } from '../../stores/reportStore';
import { useRingStore } from '../../stores/ringStore';
import { useSiteStore } from '../../stores/siteStore';
import { RECOVERY_STATUS_COLOR, RECOVERY_STATUSES, type RecoveryMatchStatus, type RecoveryReport } from '../../types/recovery';
import { parseBulletin } from '../../utils/recovery';
import { formatDate } from '../../utils/format';
import type { RingRecord } from '../../types/ring-record';

const SAMPLE_BULLETIN = `全国鸟类环志中心回捕通报（2026 年 9 月）
各环志站：
现将近期各地回收情况通报如下。
A-10231，红喉歌鸲，2026年9月18日，在崇明东滩保护站回收，环号清晰，鸟况良好。
B-20512，大山雀，2026-09-15，条子泥监测点发现死亡个体。
A-10232，黄眉柳莺，2026年9月12日，青岛环志站回收。
D-90001，红喉歌鸲，2026年9月20日，由盘锦湿地环志站回收上报。
A-10241，黑腹滨鹬，9月10日，在闽江口观鸟点重捕。
请有关站点核对后反馈。
全国鸟类环志中心`;

const reportStore = useReportStore();
const ringStore = useRingStore();
const siteStore = useSiteStore();

const emit = defineEmits<{
  (e: 'view-history', ringNo: string): void;
}>();

/* ------------------------------- 导入通报 ------------------------------- */
const importVisible = ref(false);
const bulletinText = ref('');
const importing = ref(false);

function openImport() {
  bulletinText.value = '';
  importVisible.value = true;
}

function fillSample() {
  bulletinText.value = SAMPLE_BULLETIN;
}

/** 不写库的预览：只解析，用于导入前让人核对识别结果 */
const previewItems = computed(() => {
  if (!bulletinText.value.trim()) return [];
  try {
    return parseBulletin(bulletinText.value);
  } catch {
    return [];
  }
});

const previewError = computed(() => {
  if (!bulletinText.value.trim()) return '';
  try {
    parseBulletin(bulletinText.value);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
});

async function doImport() {
  importing.value = true;
  try {
    // 出错时这里抛异常，事务保证本地记录与已对好结果不动；输入框保留原文可直接重试
    const result = await reportStore.importBulletin(bulletinText.value);
    if (result.duplicated) {
      ElMessage.warning('这段通报此前已经导入过，未重复挂接收回记录');
    } else {
      await ringStore.hydrate();
      ElMessage.success(
        `通报已导入：共 ${result.total} 条，已对账 ${result.matched}、待核实 ${result.verify}、待认领 ${result.unclaimed}，新增回收记录 ${result.createdRings} 条`,
      );
      importVisible.value = false;
    }
  } catch (error) {
    ElMessage.error(`导入失败：${(error as Error).message}。本地记录未改动，修改后可重试`);
  } finally {
    importing.value = false;
  }
}

/* ------------------------------- 列表筛选 ------------------------------- */
const activeStatus = ref<RecoveryMatchStatus | ''>('');
const filteredReports = computed(() =>
  activeStatus.value ? reportStore.byStatus[activeStatus.value] : reportStore.reports,
);

/* ------------------------------- 人工挂接 ------------------------------- */
const attachVisible = ref(false);
const attachingReport = ref<RecoveryReport | null>(null);
const attachRingId = ref('');

/** 可挂接的本地初捕记录（待认领时不限环号；待核实时优先同环号） */
const initialOptions = computed<RingRecord[]>(() => {
  const report = attachingReport.value;
  if (!report) return [];
  const sameRing = ringStore.rings.filter(
    (record) =>
      record.status === '初捕' && record.ringNo.trim().toUpperCase() === report.ringNo.trim().toUpperCase(),
  );
  const pool = sameRing.length > 0 ? sameRing : ringStore.rings.filter((record) => record.status === '初捕');
  return pool.slice().sort((a, b) => a.ringDate.localeCompare(b.ringDate));
});

function openAttach(report: RecoveryReport) {
  attachingReport.value = report;
  attachRingId.value = initialOptions.value[0]?.id ?? '';
  attachVisible.value = true;
}

async function confirmAttach() {
  if (!attachingReport.value) return;
  if (!attachRingId.value) {
    ElMessage.warning('请选择一条本地初捕记录');
    return;
  }
  try {
    await reportStore.attach(attachingReport.value.id, attachRingId.value);
    await ringStore.hydrate();
    ElMessage.success('已挂接为回收记录');
    attachVisible.value = false;
  } catch (error) {
    ElMessage.error(`挂接失败：${(error as Error).message}`);
  }
}

/* ------------------------------- 重新对账 ------------------------------- */
async function recheckAll() {
  try {
    const { matched } = await reportStore.recheck();
    await ringStore.hydrate();
    if (matched > 0) {
      ElMessage.success(`重新对账完成，${matched} 条待处理通报已自动挂上回收记录`);
    } else {
      ElMessage.info('没有可自动对账的新条目（请先登记对应初捕记录，或人工认领）');
    }
  } catch (error) {
    ElMessage.error(`重新对账失败：${(error as Error).message}`);
  }
}

/* ------------------------------- 删除 / 原文 ------------------------------- */
async function remove(report: RecoveryReport) {
  const confirmed = await ElMessageBox.confirm(
    `确认删除通报 ${report.ringNo}？由该通报自动生成 / 人工挂接的回收环志记录会一并删除，初捕记录不受影响。`,
    '删除确认',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  try {
    const removedRings = await reportStore.removeReport(report.id);
    await ringStore.hydrate();
    ElMessage.success(`已删除通报条目${removedRings > 0 ? `及 ${removedRings} 条回收记录` : ''}`);
  } catch (error) {
    ElMessage.error(`删除失败：${(error as Error).message}`);
  }
}

const sourceVisible = ref(false);
const sourceText = ref('');
function showSource(report: RecoveryReport) {
  sourceText.value = report.sourceText;
  sourceVisible.value = true;
}

function showRingHistory(ringNo: string) {
  // 交给环志记录页打开该环号历史弹窗
  emit('view-history', ringNo);
}

const statusTagType = (status: RecoveryMatchStatus) => RECOVERY_STATUS_COLOR[status];
const formatDay = (iso: string) => (iso ? formatDate(iso) : '—');
</script>

<template>
  <el-card shadow="never" class="block report-card">
    <template #header>
      <div class="card-head">
        <span>回捕通报对账</span>
        <span class="card-note">
          待认领 {{ reportStore.byStatus.待认领.length }} · 待核实
          {{ reportStore.byStatus.待核实.length }} · 已对账 {{ reportStore.byStatus.已对账.length }}
        </span>
      </div>
    </template>

    <p class="report-tip">
      把上级中心发来的通报原文整段粘贴进来，系统按金属环号与本地初捕记录对账：对得上的自动挂回收记录（带上报站点与回收日期），查无此环的列入待认领，鸟种或日期对不上的列为待核实，双方记录均保持原样。
    </p>

    <div class="report-actions">
      <el-button type="primary" :icon="Upload" @click="openImport">粘贴导入通报</el-button>
      <el-button :icon="RefreshRight" :disabled="reportStore.pendingCount === 0" @click="recheckAll">
        重新对账待处理条目
      </el-button>
      <el-radio-group v-model="activeStatus" size="small">
        <el-radio-button label="">全部</el-radio-button>
        <el-radio-button v-for="status in RECOVERY_STATUSES" :key="status" :label="status">
          {{ status }}（{{ reportStore.byStatus[status].length }}）
        </el-radio-button>
      </el-radio-group>
    </div>

    <EmptyPanel v-if="filteredReports.length === 0" description="还没有回捕通报，点击「粘贴导入通报」开始对账" />

    <el-table v-else :data="filteredReports" size="small" border>
      <el-table-column prop="ringNo" label="金属环号" width="105" />
      <el-table-column label="状态" width="90">
        <template #default="scope">
          <el-tag :type="statusTagType(scope.row.status as RecoveryMatchStatus)" size="small">
            {{ scope.row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="speciesCn" label="通报鸟种" width="100">
        <template #default="scope">{{ scope.row.speciesCn || '—' }}</template>
      </el-table-column>
      <el-table-column label="回收日期" width="105">
        <template #default="scope">{{ formatDay(scope.row.recoveryDate) }}</template>
      </el-table-column>
      <el-table-column prop="reportSite" label="上报站点" min-width="150" show-overflow-tooltip>
        <template #default="scope">{{ scope.row.reportSite || '未识别' }}</template>
      </el-table-column>
      <el-table-column label="对账说明 / 待办原因" min-width="220" show-overflow-tooltip>
        <template #default="scope">
          <span :class="{ 'verify-note': scope.row.status === '待核实' }">{{ scope.row.discrepancy }}</span>
        </template>
      </el-table-column>
      <el-table-column label="导入时间" width="105">
        <template #default="scope">{{ formatDay(scope.row.importedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="scope">
          <el-button
            v-if="scope.row.status !== '已对账'"
            link
            type="primary"
            @click="openAttach(scope.row)"
          >
            {{ scope.row.status === '待认领' ? '人工认领' : '确认挂接' }}
          </el-button>
          <el-button v-else link type="primary" @click="showRingHistory(scope.row.ringNo)">查看回收</el-button>
          <el-button link type="primary" :icon="View" @click="showSource(scope.row)">原文</el-button>
          <el-button link type="danger" @click="remove(scope.row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <!-- 导入对话框 -->
  <el-dialog v-model="importVisible" title="粘贴回捕通报" width="720px">
    <el-input
      v-model="bulletinText"
      type="textarea"
      :rows="10"
      placeholder="把上级中心通报整段粘贴到这里，支持自由文本；环号形如 A-10231、B-20511，日期支持 2026年9月18日 / 2026-09-18 / 9月18日"
    />
    <div class="import-foot">
      <el-button link type="primary" @click="fillSample">填入示例通报</el-button>
      <span class="parse-hint">识别结果预览会在下方即时显示，导入失败原文保留可修改重试</span>
    </div>

    <el-alert v-if="previewError" class="preview-block" type="error" :title="previewError" show-icon :closable="false" />
    <div v-else-if="previewItems.length > 0" class="preview-block">
      <div class="preview-title">识别到 {{ previewItems.length }} 个环号：</div>
      <el-table :data="previewItems" size="small" border max-height="200">
        <el-table-column prop="ringNo" label="环号" width="100" />
        <el-table-column label="鸟种" width="100">
          <template #default="scope">{{ scope.row.speciesCn || '未识别' }}</template>
        </el-table-column>
        <el-table-column label="回收日期" width="105">
          <template #default="scope">{{ formatDay(scope.row.recoveryDate) }}</template>
        </el-table-column>
        <el-table-column label="上报站点" min-width="130" show-overflow-tooltip>
          <template #default="scope">{{ scope.row.reportSite || '未识别' }}</template>
        </el-table-column>
      </el-table>
    </div>

    <template #footer>
      <el-button @click="importVisible = false">取消</el-button>
      <el-button type="primary" :loading="importing" @click="doImport">导入并对账</el-button>
    </template>
  </el-dialog>

  <!-- 人工认领 / 确认挂接对话框 -->
  <el-dialog v-model="attachVisible" :title="attachingReport?.status === '待认领' ? '人工认领' : '人工确认挂接'" width="560px">
    <el-descriptions v-if="attachingReport" :column="1" size="small" border class="attach-desc">
      <el-descriptions-item label="金属环号">{{ attachingReport.ringNo }}</el-descriptions-item>
      <el-descriptions-item label="通报鸟种">{{ attachingReport.speciesCn || '未注明' }}</el-descriptions-item>
      <el-descriptions-item label="回收日期">{{ formatDay(attachingReport.recoveryDate) }}</el-descriptions-item>
      <el-descriptions-item label="上报站点">{{ attachingReport.reportSite || '未识别' }}</el-descriptions-item>
      <el-descriptions-item label="待办原因">{{ attachingReport.discrepancy }}</el-descriptions-item>
    </el-descriptions>
    <el-alert
      v-if="attachingReport?.status === '待核实'"
      class="attach-warn"
      type="warning"
      :closable="false"
      title="鸟种或日期对不上仍挂接时，以人工选择为准；本地初捕记录不改动，通报信息保留在说明中"
      show-icon
    />
    <div class="attach-pick">
      <span class="attach-label">挂接到本地初捕：</span>
      <el-select v-model="attachRingId" filterable placeholder="选择初捕记录" style="width: 380px">
        <el-option
          v-for="record in initialOptions"
          :key="record.id"
          :label="`${record.ringNo} · ${record.speciesCn} · ${formatDate(record.ringDate)} · ${siteStore.siteName(record.siteId)}`"
          :value="record.id"
        />
      </el-select>
    </div>
    <template #footer>
      <el-button @click="attachVisible = false">取消</el-button>
      <el-button type="primary" @click="confirmAttach">确认挂接收回</el-button>
    </template>
  </el-dialog>

  <!-- 通报原文 -->
  <el-dialog v-model="sourceVisible" title="通报原文" width="640px">
    <pre class="source-text">{{ sourceText }}</pre>
    <template #footer>
      <el-button type="primary" @click="sourceVisible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.report-card {
  margin-bottom: 16px;
  border-radius: 8px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.card-note {
  font-size: 12px;
  color: #8a99a5;
}
.report-tip {
  margin: 0 0 10px;
  font-size: 12px;
  color: #6f8480;
  line-height: 1.7;
}
.report-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.verify-note {
  color: #b88230;
}
.import-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 6px;
}
.parse-hint {
  font-size: 12px;
  color: #8a99a5;
}
.preview-block {
  margin-top: 10px;
}
.preview-title {
  font-size: 13px;
  color: #1f4a44;
  margin-bottom: 6px;
}
.attach-desc {
  margin-bottom: 10px;
}
.attach-warn {
  margin-bottom: 10px;
}
.attach-pick {
  display: flex;
  align-items: center;
  gap: 8px;
}
.attach-label {
  font-size: 13px;
  color: #2f4a44;
  white-space: nowrap;
}
.source-text {
  white-space: pre-wrap;
  word-break: break-all;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  margin: 0;
  color: #2f4a44;
}
</style>
