import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';

const sourceUrl = 'https://img.client.10010.com/zifeizhuanquwt/index.html';
const apiBase = 'https://m.client.10010.com/servicequerybusiness/queryTariffNew';
const publicDataDir = path.resolve('public/data/unicom');
const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });

const requestHeaders = {
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/x-www-form-urlencoded',
  Origin: 'https://img.client.10010.com',
  Referer: sourceUrl,
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
};

function behaviorId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789';
  const random = Array.from({ length: 16 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds(),
  ]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : index === 6 ? 3 : 2, '0'))
    .join('');
  return `${random}${timestamp}`;
}

function post(endpoint, params, attempt = 1) {
  const body = new URLSearchParams({ version: 'WT', ...params, behaviorId: behaviorId() }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${apiBase}/${endpoint}`,
      { method: 'POST', headers: { ...requestHeaders, 'Content-Length': Buffer.byteLength(body) }, agent },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', async () => {
          try {
            const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (res.statusCode < 200 || res.statusCode >= 300 || response.code !== '0000') {
              throw new Error(`${res.statusCode} ${response.msg || response.code}`);
            }
            resolve(response);
          } catch (error) {
            if (attempt < 3) {
              await new Promise((retry) => setTimeout(retry, attempt * 800));
              resolve(post(endpoint, params, attempt + 1));
            } else {
              reject(new Error(`${endpoint}: ${error.message}`));
            }
          }
        });
      },
    );
    req.setTimeout(30000, () => req.destroy(new Error(`${endpoint}: request timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}

function number(value) {
  const match = String(value ?? '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function gb(value, unit = '') {
  const amount = number(value);
  if (/MB/i.test(unit)) return Math.round((amount / 1024) * 100) / 100;
  if (/TB/i.test(unit)) return amount * 1024;
  return amount;
}

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeItem(item, province, scope) {
  const details = item.detailsList?.length ? item.detailsList : [item];
  return details.map((detail, index) => {
    const price = number(detail.feesStandard);
    const generalData = gb(detail.commonData, detail.dataUnit);
    const directedData = gb(detail.orientTraffic, detail.orientTrafficUnit);
    const schemeId = clean(detail.reportNo || item.reportNo);
    const name = clean(detail.name || item.name);
    return {
      id: `unicom-${scope}-${province}-${schemeId || item.id || index}-${name}-${index}`.replace(/\s+/g, '-'),
      operator: 'unicom',
      name,
      area: scope === 'national' ? '全国' : province,
      price,
      data: Math.round((generalData + directedData) * 100) / 100,
      generalData,
      directedData,
      voice: number(detail.minute),
      sms: clean(detail.sms) || '详见详情',
      broadband: clean(detail.broadBand) || '详见详情',
      audience: clean(detail.useScope) || '详见详情',
      contract: [clean(detail.validPeriod), clean(detail.onlinePeriod)].filter(Boolean).join('；') || '详见详情',
      source: '中国联通资费专区',
      tags: ['套餐', '移网', scope === 'national' ? '全国资费' : '本省资费'],
      details: {
        schemeId,
        tariffStandard: price ? `${price}${clean(detail.feeUnit) || '元/月'}` : '详见详情',
        applicableArea: clean(detail.useScope),
        salesChannel: clean(detail.saleChnl),
        onlineDate: clean(detail.startDate),
        offlineDate: clean(detail.endDate),
        validity: clean(detail.validPeriod),
        networkRequirement: clean(detail.onlinePeriod),
        cancelMethod: clean(detail.unsubscribe),
        liability: clean(detail.contractDuty),
        overage: [clean(detail.extraFees), clean(detail.otherFees)].filter(Boolean).join('\n'),
        services: [clean(detail.equityCoupon), clean(detail.serviceContent)].filter((value) => value && value !== '无').join('\n'),
        notes: clean(detail.otherDesc),
        category: '套餐',
      },
    };
  });
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function fetchPlans(province, provinceCode, cityCode, tariffAttributes) {
  const scope = tariffAttributes === 1 ? 'national' : 'province';
  const menu = await post('threeLevelName', {
    tariffAttributes,
    firstLevel: '1',
    secondLevel: '1001',
    provinceId: provinceCode,
    cityId: cityCode,
  });
  const ids = (menu.data?.dataList ?? []).map((item) => item.id).filter(Boolean);
  const batches = chunks(ids, 10);
  const responses = [];
  for (let index = 0; index < batches.length; index += 6) {
    responses.push(
      ...(await Promise.all(
        batches.slice(index, index + 6).map((batch) =>
          post(`operateData/${batch.join('_')}`, {
            page: '1',
            size: '10',
            provinceId: provinceCode,
            cityId: cityCode,
          }),
        ),
      )),
    );
  }
  const items = responses.flatMap((response) => response.data?.dataList ?? response.data?.detailList ?? []);
  const plans = items
    .flatMap((item) => normalizeItem(item, province, scope))
    .filter((plan) => plan.name && plan.price > 0);
  const seen = new Set();
  return plans.filter((plan) => {
    const key = `${plan.name}|${plan.price}|${plan.details.schemeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function writeJson(file, data) {
  await fs.writeFile(path.join(publicDataDir, file), `${JSON.stringify(data, null, 2)}\n`);
}

async function main() {
  await fs.mkdir(publicDataDir, { recursive: true });
  const index = await post('indexData', { provinceId: '011', cityId: '110' });
  const provinces = index.data?.provinceList ?? [];
  const failures = [];
  const provinceEntries = [];

  const nationalPlans = await fetchPlans('北京', '011', '110', 1);
  nationalPlans.sort((a, b) => a.price - b.price || b.data - a.data);
  await writeJson('national.json', { operator: 'unicom', scope: 'national', planCount: nationalPlans.length, plans: nationalPlans });

  for (const entry of provinces) {
    process.stdout.write(`Fetching ${entry.provName}（${entry.cityName}）... `);
    try {
      const plans = await fetchPlans(entry.provName, entry.provCode, entry.cityCode, 2);
      plans.sort((a, b) => a.price - b.price || b.data - a.data);
      await writeJson(`${entry.provName}.json`, {
        operator: 'unicom',
        scope: 'province',
        province: entry.provName,
        representativeCity: entry.cityName,
        planCount: plans.length,
        plans,
      });
      provinceEntries.push({
        province: entry.provName,
        provinceCode: entry.provCode,
        representativeCity: entry.cityName,
        cityCode: entry.cityCode,
        planCount: plans.length,
      });
      console.log(`${plans.length} plans`);
    } catch (error) {
      failures.push({ province: entry.provName, error: error.message });
      provinceEntries.push({
        province: entry.provName,
        provinceCode: entry.provCode,
        representativeCity: entry.cityName,
        cityCode: entry.cityCode,
        planCount: 0,
      });
      await writeJson(`${entry.provName}.json`, {
        operator: 'unicom',
        scope: 'province',
        province: entry.provName,
        representativeCity: entry.cityName,
        planCount: 0,
        plans: [],
      });
      console.log(`failed: ${error.message}`);
    }
  }

  const planCount = nationalPlans.length + provinceEntries.reduce((sum, entry) => sum + entry.planCount, 0);
  await writeJson('index.json', {
    operator: 'unicom',
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    provinceCount: provinces.length,
    failureCount: failures.length,
    failures,
    nationalPlanCount: nationalPlans.length,
    planCount,
    provinces: provinceEntries.sort((a, b) => a.province.localeCompare(b.province, 'zh-Hans-CN')),
  });
  console.log(`Wrote ${planCount} China Unicom plans to ${publicDataDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
