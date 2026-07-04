import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import vm from 'node:vm';
import { constants as cryptoConstants } from 'node:crypto';

const pageUrl = 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html';
const origin = 'https://h.app.coc.10086.cn';
const endpointPath = '/biz-orange/DH/tariffZone/getTariffListForPC';
const endpointUrl = `${origin}${endpointPath}`;

const outputDir = path.resolve('src/data');
const rawOutputPath = path.join(outputDir, 'cmcc-tariffs.raw.json');
const generatedOutputPath = path.join(outputDir, 'cmcc-tariffs.generated.json');

const provinces = [
  ['551', '安徽'],
  ['100', '北京'],
  ['230', '重庆'],
  ['591', '福建'],
  ['931', '甘肃'],
  ['200', '广东'],
  ['771', '广西'],
  ['851', '贵州'],
  ['898', '海南'],
  ['311', '河北'],
  ['371', '河南'],
  ['451', '黑龙江'],
  ['270', '湖北'],
  ['731', '湖南'],
  ['431', '吉林'],
  ['250', '江苏'],
  ['791', '江西'],
  ['240', '辽宁'],
  ['471', '内蒙古'],
  ['951', '宁夏'],
  ['971', '青海'],
  ['531', '山东'],
  ['290', '陕西'],
  ['351', '山西'],
  ['210', '上海'],
  ['280', '四川'],
  ['220', '天津'],
  ['891', '西藏'],
  ['991', '新疆'],
  ['871', '云南'],
  ['571', '浙江'],
];

const tariffDataTypes = [
  { id: '1', label: '全部资费', normalize: false },
  { id: '2', label: '全网资费', normalize: true },
  { id: '3', label: '分省资费', normalize: true },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(url, { body, headers = {}, method = 'GET', timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const requestBody = body ?? null;
    const req = https.request(
      url,
      {
        method,
        headers: {
          ...(requestBody ? { 'Content-Length': Buffer.byteLength(requestBody) } : {}),
          ...headers,
        },
        secureOptions: cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
    });
    if (requestBody) req.write(requestBody);
    req.end();
  });
}

async function fetchText(url) {
  const response = await request(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
  }

  return response.text;
}

function extractScriptUrls(html) {
  const matches = [...html.matchAll(/<script[^>]+src="([^"]+\.js(?:\?[^"]*)?)"[^>]*>/g)].map((match) =>
    match[1].replace(/&amp;/g, '&'),
  );
  return matches
    .filter((src) => src.includes('/cmcc-app/'))
    .map((src) => new URL(src, pageUrl).href);
}

async function loadRuntime() {
  const html = await fetchText(pageUrl);
  const scriptUrls = extractScriptUrls(html);
  const mainUrl = scriptUrls.find((url) => /\/tariffZonePers\.js(?:\?|$)/.test(url));

  if (!mainUrl) {
    throw new Error('Could not find tariffZonePers entry script.');
  }

  const orderedUrls = [
    mainUrl,
    ...scriptUrls.filter((url) => url !== mainUrl && /chunk-vendors/.test(url)),
    ...scriptUrls.filter((url) => url !== mainUrl && /chunk-common/.test(url)),
    ...scriptUrls.filter((url) => url !== mainUrl && /templateCollection/.test(url)),
  ];

  const scripts = await Promise.all(orderedUrls.map((url) => fetchText(url)));
  const mainEntryIndex = scripts[0].indexOf('var _0x2c34ba=');

  if (mainEntryIndex === -1) {
    throw new Error('Could not expose webpack runtime from entry script.');
  }

  scripts[0] = `${scripts[0].slice(0, mainEntryIndex)}self.__req=_0x10397c;}());`;

  const navigator = { userAgent: 'node' };
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
  const document = {
      createElement: () => ({ setAttribute() {}, appendChild() {} }),
      getElementsByTagName: () => [{ appendChild() {} }],
      head: { appendChild() {} },
  };
  const location = new URL(pageUrl);
  const context = {
    self: { navigator, document, location, localStorage: storage, sessionStorage: storage },
    window: { navigator, document, location, localStorage: storage, sessionStorage: storage },
    document,
    navigator,
    location,
    localStorage: storage,
    sessionStorage: storage,
    console,
    setTimeout,
    clearTimeout,
    Image: class {
      set src(_value) {}
    },
  };

  context.self.window = context.window;
  context.window.self = context.self;
  vm.createContext(context);

  for (const script of scripts) {
    vm.runInContext(script, context);
  }

  const req = context.__req || context.self.__req;
  if (!req) {
    throw new Error('Webpack require was not exposed.');
  }

  return {
    crypto: req(0xaa31),
    cryptoJs: req(0x6129),
    util: req(0x14cc7),
  };
}

async function requestTariffList(runtime, provinceCode, tariffDataType) {
  const xk = runtime.crypto.wc();
  const userInfo = {
    cid: '0',
    en: '0',
    token: '0',
    sn: '0',
    version: '0',
    st: '0',
    sv: '0',
    sp: '0',
    xk: '0',
    channel: 'web',
    province: provinceCode,
    city: '0000',
    phoneNumber: '',
    osType: '0',
  };
  const reqBody = {
    cellNum: '99999999999',
    provinceCode,
    cityCode: '0000',
    channelType: '1',
    tariffDataType,
    priceTypes: ['1'],
  };
  const time = Date.now();
  const nonce = runtime.crypto.jG(8);
  const token = runtime.crypto._f(`${xk}_${endpointPath}_${time}_${nonce}`);
  const sign = runtime.cryptoJs.MD5(`${token}_${time}_${nonce}_${null}`).toString();
  const body = runtime.crypto._f(runtime.util.xs({ ...userInfo, reqBody, xk }, reqBody));

  const response = await request(endpointUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json; charset=utf-8',
      Origin: origin,
      Referer: pageUrl,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      TRACE: `${xk}_${endpointPath}_${time}_${runtime.crypto.jG(20, true)}`,
      'x-appToken': 'JSESSIONID=;UID=;ticketID=;Comment=SessionServer-unity',
      'x-nonce': nonce,
      'x-qen': '1',
      'x-sign': sign,
      'x-time': String(time),
      'x-token': token,
    },
    body,
  });

  let encrypted;
  try {
    encrypted = JSON.parse(response.text);
  } catch (error) {
    throw new Error(`API returned non-JSON for ${provinceCode}/${tariffDataType}: ${response.status} ${response.text.slice(0, 160)}`);
  }
  const decrypted = JSON.parse(runtime.crypto.yl(encrypted.body));

  if (!response.ok || decrypted.retCode !== '000000') {
    throw new Error(`API failed for ${provinceCode}/${tariffDataType}: ${response.status} ${decrypted.retDesc}`);
  }

  return decrypted;
}

async function requestTariffListWithRetry(runtime, provinceCode, tariffDataType, attempt = 1) {
  try {
    return await requestTariffList(runtime, provinceCode, tariffDataType);
  } catch (error) {
    if (attempt >= 2) throw error;
    await sleep(1200);
    return requestTariffListWithRetry(runtime, provinceCode, tariffDataType, attempt + 1);
  }
}

function stripHtml(value = '') {
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstNumber(value) {
  const match = String(value ?? '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
}

function gbValue(value, label = '') {
  const text = String(value ?? '');
  if (!text || /不限|免费/.test(text)) return 0;
  const number = firstNumber(text);
  if (/MB/i.test(`${label} ${text}`)) return Math.round((number / 1024) * 10) / 10;
  return number;
}

function normalizeTable(table) {
  const heads = table?.tableInfo?.tHead ?? [];
  const rows = table?.tableInfo?.tBody ?? [];
  const labels = Object.fromEntries(heads.flatMap((head) => Object.entries(head)));
  return {
    title: table?.tableTitle ?? '',
    rows: rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([field, value]) => [labels[field] || field, stripHtml(value)]),
      ),
    ),
  };
}

function collectItems(response, provinceName, scopeLabel) {
  const items = [];
  const typeList = response?.rspBody?.tariffTypeList ?? [];

  for (const type of typeList) {
    const info = type.tariffInfoResult ?? {};
    for (const [listName, list] of Object.entries(info)) {
      if (!Array.isArray(list) || listName === 'navigationList' || listName === 'areaTypeSortList') continue;
      for (const item of list) {
        items.push({
          ...item,
          _provinceName: provinceName,
          _scopeLabel: scopeLabel,
          _category: type.tariffTypeTitle,
          _categoryId: type.tariffTypeId,
          _listName: listName,
        });
      }
    }
  }

  return items;
}

function rowPrice(row) {
  const priceEntry = Object.entries(row).find(([label]) => /费用|月费|月租|资费|套餐费/.test(label));
  return firstNumber(priceEntry?.[1]);
}

function rowValue(row, matcher) {
  const entry = Object.entries(row).find(([label]) => matcher.test(label));
  return entry?.[1] ?? '';
}

function rowEntry(row, matcher) {
  const entry = Object.entries(row).find(([label]) => matcher.test(label));
  return entry ? { label: entry[0], value: entry[1] } : null;
}

function normalizeItem(item, sourceIndex) {
  const tables = (item.tableList ?? []).map(normalizeTable).filter((table) => table.rows.length);
  const primaryTable =
    tables.find((table) => table.rows.some((row) => rowPrice(row) > 0)) ??
    tables.find((table) => table.rows.length) ??
    null;
  const rows = primaryTable?.rows?.length ? primaryTable.rows : [{}];

  return rows.map((row, rowIndex) => {
    const price = rowPrice(row) || firstNumber(item.chargesName || item.title);
    const generalDataEntry =
      rowEntry(row, /通用.*流量|流量.*通用|国内流量|套内流量|移动数据流量/) ||
      rowEntry(row, /流量/) ||
      { label: '', value: '' };
    const directedDataEntry = rowEntry(row, /定向|专属|权益流量/) || { label: '', value: '' };
    const voiceText = rowValue(row, /通话|语音|主叫|分钟/);
    const smsText = rowValue(row, /短信/);
    const broadbandText =
      rowValue(row, /宽带/) ||
      tables
        .flatMap((table) => table.rows)
        .find((candidate) => rowPrice(candidate) === price && rowValue(candidate, /宽带/))?.[
        Object.keys(tables.flatMap((table) => table.rows).find((candidate) => rowPrice(candidate) === price && rowValue(candidate, /宽带/)) ?? {}).find((label) =>
          /宽带/.test(label),
        )
      ];
    const generalData = gbValue(generalDataEntry.value, generalDataEntry.label);
    const directedData = gbValue(directedDataEntry.value, directedDataEntry.label);
    const variantLabel = rows.length > 1 && price ? `${price}元档` : '';
    const name = variantLabel ? `${item.title} ${variantLabel}` : item.title;

    return {
      id: `cmcc-${item._provinceName}-${item._scopeLabel}-${item.markId || item.tariffCode || sourceIndex}-${rowIndex}`.replace(
        /\s+/g,
        '-',
      ),
      name,
      area: item._scopeLabel === '全网资费' ? '全国' : item._provinceName,
      price,
      data: Math.round((generalData + directedData) * 10) / 10,
      generalData,
      directedData,
      voice: firstNumber(voiceText),
      sms: smsText || '详见详情',
      broadband: broadbandText || '详见详情',
      audience: stripHtml(item.applyRange || item.limitingCondition || '详见详情'),
      contract: stripHtml(item.expirationDesc || item.networkDeadline || '详见详情'),
      source: '中国移动资费公示专区',
      tags: [item._category, item.navigationName, item._scopeLabel].filter(Boolean),
      details: {
        schemeId: item.tariffCode || item.markId,
        markId: item.markId,
        tariffStandard: item.chargesName || (price ? `${price}元/月` : '详见详情'),
        applicableArea: item._scopeLabel === '全网资费' ? '全国' : item._provinceName,
        salesChannel: stripHtml(item.marketingChannel || ''),
        onlineDate: item.expirationStartDate || '',
        offlineDate: item.expirationEndDate || '',
        validity: stripHtml(item.expirationDesc || item.networkDeadline || ''),
        networkRequirement: stripHtml(item.networkDeadline || ''),
        liability: stripHtml(item.violateDuty || ''),
        overage: stripHtml(rowValue(row, /套外|超出|超套|套餐外/) || ''),
        services: stripHtml(item.detail || ''),
        notes: stripHtml(item.limitingCondition || ''),
        category: item._category,
        navigationName: item.navigationName || '',
        sourceTableTitles: tables.map((table) => table.title).filter(Boolean),
      },
    };
  });
}

function uniquePlans(plans) {
  const seen = new Set();
  return plans.filter((plan) => {
    const key = [plan.area, plan.name, plan.price, plan.generalData, plan.directedData, plan.voice].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const raw = [];
  const sourceItems = [];
  const failures = [];

  if (process.argv.includes('--from-raw')) {
    raw.push(...JSON.parse(await fs.readFile(rawOutputPath, 'utf8')));
    for (const entry of raw) {
      if (entry.normalize !== false) {
        sourceItems.push(...collectItems(entry.response, entry.provinceName, entry.scopeLabel));
      }
    }
  } else {
    const runtime = await loadRuntime();
    for (const [provinceCode, provinceName] of provinces) {
      for (const tariffDataType of tariffDataTypes) {
        process.stdout.write(`Fetching ${provinceName} ${tariffDataType.label}... `);
        try {
          const response = await requestTariffListWithRetry(runtime, provinceCode, tariffDataType.id);
          raw.push({
            provinceCode,
            provinceName,
            tariffDataType: tariffDataType.id,
            scopeLabel: tariffDataType.label,
            normalize: tariffDataType.normalize,
            response,
          });
          if (tariffDataType.normalize) {
            sourceItems.push(...collectItems(response, provinceName, tariffDataType.label));
          }
          console.log('ok');
        } catch (error) {
          failures.push({
            provinceCode,
            provinceName,
            tariffDataType: tariffDataType.id,
            scopeLabel: tariffDataType.label,
            error: error.message,
          });
          console.log(`failed: ${error.message}`);
        }
        await sleep(220);
      }
    }
  }

  const plans = uniquePlans(sourceItems.flatMap((item, index) => normalizeItem(item, index)))
    .filter((plan) => plan.name && plan.price > 0)
    .sort((a, b) => a.price - b.price || b.data - a.data || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  const generated = {
    sourceUrl: pageUrl,
    fetchedAt: new Date().toISOString(),
    provinceCount: provinces.length,
    responseCount: raw.length,
    failureCount: failures.length,
    failures,
    sourceItemCount: sourceItems.length,
    planCount: plans.length,
    plans,
  };

  await fs.writeFile(rawOutputPath, `${JSON.stringify(raw, null, 2)}\n`);
  await fs.writeFile(generatedOutputPath, `${JSON.stringify(generated, null, 2)}\n`);

  console.log(`Wrote ${rawOutputPath}`);
  console.log(`Wrote ${generatedOutputPath}`);
  console.log(`Normalized ${plans.length} plans from ${sourceItems.length} source items.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
