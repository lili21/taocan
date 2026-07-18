import fs from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const beforeDir = path.resolve(args.get('--before') || 'public/data');
const afterDir = path.resolve(args.get('--after') || 'public/data');
const outputPath = path.resolve(args.get('--output') || 'public/data/changes/latest.json');
const reportPath = args.get('--report') ? path.resolve(args.get('--report')) : null;

const operatorConfigs = [
  { key: 'cmcc', label: '中国移动', relativeDir: '' },
  { key: 'unicom', label: '中国联通', relativeDir: 'unicom' },
  { key: 'telecom', label: '中国电信', relativeDir: 'telecom' },
];

function stableKey(operator, plan) {
  const area = plan.area || plan.details?.applicableArea || '未知地区';
  const schemeId = String(plan.details?.schemeId || '').trim();
  if (schemeId) return `${operator}|${area}|scheme:${schemeId}`;
  return `${operator}|${area}|plan:${plan.name}|${plan.price}`;
}

function comparable(plan) {
  return {
    name: plan.name,
    area: plan.area,
    price: plan.price,
    data: plan.data,
    generalData: plan.generalData,
    directedData: plan.directedData,
    voice: plan.voice,
    audience: plan.audience,
    contract: plan.contract,
    details: {
      applicableArea: plan.details?.applicableArea,
      salesChannel: plan.details?.salesChannel,
      onlineDate: plan.details?.onlineDate,
      offlineDate: plan.details?.offlineDate,
      validity: plan.details?.validity,
      networkRequirement: plan.details?.networkRequirement,
      overage: plan.details?.overage,
    },
  };
}

async function loadPlans(root, config) {
  const directory = path.join(root, config.relativeDir);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }

  const plans = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'index.json') continue;
    const payload = JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8'));
    for (const plan of payload.plans || []) {
      plans.set(stableKey(config.key, plan), plan);
    }
  }
  return plans;
}

async function validateFetch(root, config) {
  const indexPath = path.join(root, config.relativeDir, 'index.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  if ((index.failureCount || 0) > 0) {
    throw new Error(`${config.label}本次抓取有 ${index.failureCount} 个失败项，已停止发布，避免误报套餐下架。`);
  }
}

function summarizePlan(operator, plan) {
  return {
    operator,
    area: plan.area,
    name: plan.name,
    price: plan.price,
    data: plan.data,
    voice: plan.voice,
    schemeId: plan.details?.schemeId || '',
  };
}

function compare(operator, before, after) {
  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, plan] of after) {
    const previous = before.get(key);
    if (!previous) {
      added.push(summarizePlan(operator, plan));
    } else if (JSON.stringify(comparable(previous)) !== JSON.stringify(comparable(plan))) {
      changed.push({
        ...summarizePlan(operator, plan),
        before: comparable(previous),
        after: comparable(plan),
      });
    }
  }

  for (const [key, plan] of before) {
    if (!after.has(key)) removed.push(summarizePlan(operator, plan));
  }

  return { added, changed, removed };
}

function markdownReport(result) {
  const lines = [
    '# 套餐变更监控',
    '',
    `检测时间：${result.checkedAt}`,
    '',
    `新增 ${result.summary.added} 条，变更 ${result.summary.changed} 条，下架 ${result.summary.removed} 条。`,
    '',
  ];

  for (const operator of result.operators) {
    lines.push(`## ${operator.label}`, '');
    lines.push(
      `新增 ${operator.added.length} 条，变更 ${operator.changed.length} 条，下架 ${operator.removed.length} 条。`,
      '',
    );
    if (operator.added.length) {
      lines.push('### 新增套餐', '');
      for (const plan of operator.added.slice(0, 50)) {
        lines.push(`- ${plan.area}｜${plan.name}｜${plan.price} 元/月｜${plan.data || 0}GB`);
      }
      if (operator.added.length > 50) lines.push(`- 其余 ${operator.added.length - 50} 条见变更文件`);
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

const operatorResults = [];
for (const config of operatorConfigs) {
  const before = await loadPlans(beforeDir, config);
  const after = await loadPlans(afterDir, config);
  if (beforeDir !== afterDir) await validateFetch(afterDir, config);
  if (before.size && after.size < before.size * 0.5) {
    throw new Error(`${config.label}抓取结果从 ${before.size} 条降至 ${after.size} 条，疑似抓取失败，已停止发布。`);
  }
  operatorResults.push({
    key: config.key,
    label: config.label,
    beforeCount: before.size,
    afterCount: after.size,
    ...compare(config.label, before, after),
  });
}

const summary = operatorResults.reduce(
  (totals, operator) => ({
    added: totals.added + operator.added.length,
    changed: totals.changed + operator.changed.length,
    removed: totals.removed + operator.removed.length,
  }),
  { added: 0, changed: 0, removed: 0 },
);
const changeCount = summary.added + summary.changed + summary.removed;
const result = {
  checkedAt: new Date().toISOString(),
  summary,
  operators: operatorResults,
};

if (changeCount > 0) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}

const report = markdownReport(result);
if (reportPath) await fs.writeFile(reportPath, report);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, report);
if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(
    process.env.GITHUB_OUTPUT,
    `changes=${changeCount}\nadded=${summary.added}\nchanged=${summary.changed}\nremoved=${summary.removed}\n`,
  );
}

console.log(report);
