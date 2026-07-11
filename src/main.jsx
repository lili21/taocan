import React, { useEffect, useMemo, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Analytics } from '@vercel/analytics/react';
import {
  ArrowUpRight,
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  LocateFixed,
  ListFilter,
  Loader2,
  Maximize2,
  Moon,
  Sun,
  Zap,
} from 'lucide-react';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import {
  fetchNationalPlans,
  fetchProvincePlans,
  fetchTariffIndex,
  operators,
  provinceCenters,
} from './data/tariffs';
import { resolveUserProvince } from './lib/locate-ip';
import './styles.css';

const areas = Object.keys(provinceCenters);
const defaultArea = '上海';
const tableGridTemplate = 'minmax(220px,3fr) minmax(90px,1fr) minmax(88px,1fr) minmax(88px,1fr) minmax(88px,1fr) minmax(88px,1fr) minmax(180px,2fr) minmax(86px,1fr)';

function formatData(value) {
  return value > 0 ? `${value}GB` : '-';
}

function formatVoice(value) {
  return value > 0 ? `${value} 分钟` : '-';
}

function formatPrice(value) {
  return Number.isInteger(value) ? value : value.toFixed(2);
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function getPlanType(plan) {
  const category = plan.details?.category ?? '';
  return category.includes('活动') || plan.name.includes('活动') ? 'activity' : 'plan';
}

function getPlanTags(plan) {
  const tags = uniqueValues(plan.tags ?? []);
  const typeLabel = getPlanType(plan) === 'activity' ? '活动' : '套餐';
  return tags.includes(typeLabel) ? tags : [typeLabel, ...tags];
}

function formatContract(contract) {
  return uniqueValues(String(contract ?? '').split(/[；;]/)).join('；');
}

function buildCallScript(plan) {
  const operator = operators[plan.operator] ?? { label: '运营商', servicePhone: '客服热线' };
  const schemeId = plan.details?.schemeId || '公示页面未注明';
  const eligibility = uniqueValues([plan.audience, plan.details?.applicableArea]).join('；') || '公示页面未注明';
  const salesChannel = plan.details?.salesChannel || '公示页面未注明';
  const contract = uniqueValues([
    plan.details?.validity,
    plan.details?.networkRequirement,
    plan.contract,
  ]).join('；') || '公示页面未注明';
  const hasExplicitRestriction = /新入网|新用户|存量|老用户|仅限|指定|目标客户|在网用户/.test(
    eligibility,
  );

  return [
    `拨打：${operator.label} ${operator.servicePhone}`,
    '',
    `你好，我是本机号码用户，想把当前号码变更为“${plan.name}”，方案编号是“${schemeId}”。请按官方资费公示帮我核验本号码是否满足办理条件。`,
    '',
    `公示适用范围：${eligibility}`,
    `公示办理渠道：${salesChannel}`,
    `公示合约或在网要求：${contract}`,
    '',
    hasExplicitRestriction
      ? '我注意到公示中存在用户资格条件，请按公示原文逐项核验，并说明我的号码具体是否符合。'
      : '如果系统提示不能办理，请先核对公示中是否明确写有“仅限新入网用户”等资格限制。',
    '如果不能办理，请明确说明我具体不符合哪一项：用户类型、地区、当前套餐、在网状态、合约，还是办理渠道限制。请不要只回复“系统不支持”。',
    '如果当前坐席没有办理权限，请告知可办理的线上渠道或营业厅，或转资费专席、值班经理进一步核验。',
    '请为本次资格核验和办理诉求建立工单，并告知我工单编号以及最终处理时限。谢谢。',
  ].join('\n');
}

function nearestProvince(latitude, longitude) {
  return Object.entries(provinceCenters)
    .map(([province, [lat, lon]]) => ({
      province,
      distance: Math.hypot(latitude - lat, longitude - lon),
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.province;
}

function App() {
  const [theme, setTheme] = useState('dark');
  const [selectedOperator, setSelectedOperator] = useState('cmcc');
  const [selectedArea, setSelectedArea] = useState(defaultArea);
  const [maxPrice, setMaxPrice] = useState(999);
  const [minimumData, setMinimumData] = useState(0);
  const [scopeFilter, setScopeFilter] = useState('national');
  const [typeFilter, setTypeFilter] = useState('plan');
  const [locationStatus, setLocationStatus] = useState(`默认展示${defaultArea}，正在识别地区...`);
  const [selectedPlanId, setSelectedPlanId] = useState(null);
  const [visibleCount, setVisibleCount] = useState(50);
  const [canEnterFullscreen, setCanEnterFullscreen] = useState(false);

  const [nationalPlans, setNationalPlans] = useState([]);
  const [provincePlans, setProvincePlans] = useState([]);
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [provinceLoading, setProvinceLoading] = useState(false);

  const telecomAreas = useMemo(
    () => metadata?.provinces?.filter((province) => typeof province === 'string') ?? [],
    [metadata],
  );
  const selectableAreas = selectedOperator === 'telecom' && telecomAreas.length ? telecomAreas : areas;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { province, source } = await resolveUserProvince();
        if (cancelled) return;
        if (province) {
          setSelectedArea(province);
          setLocationStatus(
            source === 'cache' ? `已从缓存识别地区 ${province}` : `已根据 IP 识别地区 ${province}`,
          );
        } else {
          setLocationStatus(`未能识别地区，默认展示${defaultArea}，可手动切换`);
        }
      } catch {
        if (!cancelled) setLocationStatus(`IP 定位失败，默认展示${defaultArea}，可手动切换`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMetadata(null);
    setNationalPlans([]);
    setProvincePlans([]);
    setSelectedPlanId(null);
    (async () => {
      try {
        const [index, plans] = await Promise.all([
          fetchTariffIndex(selectedOperator),
          fetchNationalPlans(selectedOperator),
        ]);
        if (!cancelled) {
          setMetadata(index);
          setNationalPlans(plans);
        }
      } catch {
        if (!cancelled) setNationalPlans([]);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setHasLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedOperator]);

  useEffect(() => {
    if (selectedOperator !== 'telecom' || !telecomAreas.length) return;
    if (!telecomAreas.includes(selectedArea)) {
      setSelectedArea(telecomAreas.includes(defaultArea) ? defaultArea : telecomAreas[0]);
    }
  }, [selectedArea, selectedOperator, telecomAreas]);

  useEffect(() => {
    const isStandalone =
      window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
    setCanEnterFullscreen(Boolean(document.documentElement.requestFullscreen) && !isStandalone);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (scopeFilter === 'national') {
      setProvincePlans([]);
      setProvinceLoading(false);
      return undefined;
    }
    setProvinceLoading(true);
    (async () => {
      try {
        const plans = await fetchProvincePlans(selectedOperator, selectedArea);
        if (!cancelled) setProvincePlans(plans);
      } catch {
        if (!cancelled) setProvincePlans([]);
      } finally {
        if (!cancelled) setProvinceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeFilter, selectedOperator, selectedArea]);

  const visibleTariffs = useMemo(() => {
    const pool = [
      ...(scopeFilter === 'province' ? [] : nationalPlans),
      ...(scopeFilter === 'national' ? [] : provincePlans),
    ];
    return pool
      .filter((plan) => plan.price <= maxPrice)
      .filter((plan) => plan.data >= minimumData)
      .filter((plan) => getPlanType(plan) === typeFilter)
      .sort((a, b) => a.price - b.price || b.data - a.data);
  }, [scopeFilter, maxPrice, minimumData, typeFilter, nationalPlans, provincePlans]);

  useEffect(() => {
    setVisibleCount(50);
  }, [scopeFilter, maxPrice, minimumData, typeFilter, selectedArea]);

  const allLoadedPlans = useMemo(
    () => [...nationalPlans, ...provincePlans],
    [nationalPlans, provincePlans],
  );

  const selectedPlan = useMemo(
    () => allLoadedPlans.find((plan) => plan.id === selectedPlanId),
    [allLoadedPlans, selectedPlanId],
  );
  const selectedRegionLabel = useMemo(() => {
    if (selectedOperator !== 'unicom' || scopeFilter !== 'province') return selectedArea;
    const province = metadata?.provinces?.find((entry) => entry.province === selectedArea);
    return province?.representativeCity
      ? `${selectedArea}（${province.representativeCity}口径）`
      : selectedArea;
  }, [metadata, scopeFilter, selectedArea, selectedOperator]);

  const locateUser = () => {
    if (!navigator.geolocation) {
      setLocationStatus('浏览器不支持定位，请手动选择地区');
      return;
    }

    setLocationStatus('正在请求浏览器定位...');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const province = nearestProvince(position.coords.latitude, position.coords.longitude);
        if (province) {
          setSelectedArea(province);
          setSelectedPlanId(null);
          setLocationStatus(`已根据浏览器定位近似匹配到 ${province}`);
        } else {
          setLocationStatus('未能识别省份，请手动选择地区');
        }
      },
      () => setLocationStatus('定位未授权或失败，请手动选择地区'),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
    );
  };

  const enterImmersiveMode = async () => {
    if (!document.documentElement.requestFullscreen) {
      setLocationStatus('当前浏览器不支持直接进入沉浸模式，请添加到主屏幕后打开');
      return;
    }

    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      setCanEnterFullscreen(false);
      setLocationStatus('已进入沉浸模式');
    } catch {
      setLocationStatus('当前浏览器不允许直接隐藏导航栏，请添加到主屏幕后打开');
    }
  };

  if (loading && !hasLoaded) {
    return (
      <main className={theme}>
        <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      </main>
    );
  }

  return (
    <main className={theme}>
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))] sm:px-6 lg:px-8">
          <header className="sticky top-0 z-20 flex flex-col gap-3 border-b border-border bg-background/92 px-0 py-3 backdrop-blur md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
                <Zap className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">{operators[selectedOperator].label}公开资费</p>
                <h1 className="truncate text-base font-semibold tracking-normal sm:text-lg">套餐透明表</h1>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-[136px]">
                <select
                  className="h-9 w-full appearance-none rounded-md border border-input bg-background/60 px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  id="area"
                  onChange={(event) => {
                    setSelectedArea(event.target.value);
                    setSelectedPlanId(null);
                    setLocationStatus(`已切换到 ${event.target.value}`);
                  }}
                  value={selectedArea}
                >
                  {selectableAreas.map((area) => (
                    <option key={area} value={area}>
                      {area}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
              <Button aria-label="定位地区" onClick={locateUser} size="icon" type="button" variant="outline">
                <LocateFixed className="h-4 w-4" />
              </Button>
              {canEnterFullscreen && (
                <Button
                  aria-label="进入沉浸模式"
                  className="sm:hidden"
                  onClick={enterImmersiveMode}
                  size="icon"
                  type="button"
                  variant="outline"
                >
                  <Maximize2 className="h-4 w-4" />
                </Button>
              )}
              <a
                className="hidden h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:inline-flex"
                href={operators[selectedOperator].sourceUrl}
                rel="noreferrer"
                target="_blank"
              >
                原始公示
                <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
              <Button
                aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
                onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
                size="icon"
                type="button"
                variant="outline"
              >
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </div>
          </header>

          <p className="text-xs text-muted-foreground">{locationStatus}</p>

          {selectedPlan ? (
            <PlanDetail plan={selectedPlan} onBack={() => setSelectedPlanId(null)} />
          ) : (
            <section className="grid gap-4">
              <Card className="bg-card">
                <CardContent className="grid gap-4 p-3 lg:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_1fr_auto] xl:items-end">
                  <FilterGroup
                    label="运营商"
                    onChange={(operator) => {
                      setLoading(true);
                      setSelectedOperator(operator);
                      if (operator === 'telecom') setScopeFilter('province');
                    }}
                    options={Object.entries(operators).map(([value, operator]) => ({
                      label: operator.shortLabel,
                      value,
                    }))}
                    value={selectedOperator}
                  />
                  <FilterGroup
                    label="范围"
                    onChange={setScopeFilter}
                    options={selectedOperator === 'telecom'
                      ? [{ label: '本地区', value: 'province' }]
                      : [
                          { label: '全网', value: 'national' },
                          { label: '本地区', value: 'province' },
                        ]}
                    value={scopeFilter}
                  />
                  <FilterGroup
                    label="类型"
                    onChange={setTypeFilter}
                    options={[
                      { label: '套餐', value: 'plan' },
                      { label: '活动', value: 'activity' },
                    ]}
                    value={typeFilter}
                  />
                  <FilterGroup
                    label="最高月租"
                    onChange={setMaxPrice}
                    options={[
                      { label: '不限', value: 999 },
                      { label: '30 元', value: 30 },
                      { label: '50 元', value: 50 },
                      { label: '70 元', value: 70 },
                    ]}
                    value={maxPrice}
                  />
                  <FilterGroup
                    label="最低总流量"
                    onChange={setMinimumData}
                    options={[
                      { label: '不限', value: 0 },
                      { label: '30GB', value: 30 },
                      { label: '60GB', value: 60 },
                      { label: '80GB', value: 80 },
                    ]}
                    value={minimumData}
                  />
                  <div
                    className="flex h-10 items-center gap-2 rounded-md border border-border px-3 text-sm text-muted-foreground"
                    title={metadata ? `已抓取 ${metadata.planCount} 条套餐，接口失败 ${metadata.failureCount ?? 0} 条` : ''}
                  >
                    <ListFilter className="h-4 w-4" />
                    {loading || provinceLoading ? '加载中' : `${visibleTariffs.length} 条`}
                  </div>
                </CardContent>
              </Card>

              <Card aria-busy={loading || provinceLoading} className="relative overflow-hidden bg-card">
                <CardHeader className="flex-row items-center justify-between gap-3 border-b border-border">
                  <div>
                    <p className="text-xs font-medium text-primary">
                      {scopeFilter === 'national' ? '全网资费' : selectedRegionLabel}
                    </p>
                    <CardTitle>公开资费列表</CardTitle>
                  </div>
                  <Badge>{visibleTariffs.length} 条资费</Badge>
                </CardHeader>
                {(loading || provinceLoading) && (
                  <div className="absolute inset-x-0 bottom-0 top-[73px] z-10 flex items-center justify-center bg-card/80 backdrop-blur-[1px]">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      正在加载资费
                    </div>
                  </div>
                )}
                <div className={`grid gap-3 p-3 transition-opacity lg:hidden ${loading || provinceLoading ? 'opacity-40' : ''}`}>
                  {visibleTariffs.slice(0, visibleCount).map((plan) => (
                    <article className="rounded-lg border border-border bg-background p-4" key={plan.id}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-medium leading-6">{plan.name}</h3>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {getPlanTags(plan).map((tag) => (
                              <Badge className="h-5 px-2 text-[11px]" key={tag}>
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <div className="font-mono text-xl font-semibold text-primary">¥{formatPrice(plan.price)}</div>
                      </div>

                      <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
                        <CompactMetric label="总流量" value={formatData(plan.data)} />
                        <CompactMetric label="通用" value={formatData(plan.generalData)} />
                        <CompactMetric label="定向" value={formatData(plan.directedData)} />
                      </div>

                      <div className="mt-4 flex items-center justify-between gap-3">
                        <p className="text-xs text-muted-foreground">{formatContract(plan.contract)}</p>
                        <Button className="min-w-14 shrink-0" onClick={() => setSelectedPlanId(plan.id)} size="sm" type="button" variant="outline">
                          详情
                        </Button>
                      </div>
                    </article>
                  ))}
                  {visibleCount < visibleTariffs.length && (
                    <button
                      className="rounded-md border border-border py-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent"
                      onClick={() => setVisibleCount((c) => c + 50)}
                      type="button"
                    >
                      加载更多（剩余 {visibleTariffs.length - visibleCount} 条）
                    </button>
                  )}
                </div>

                <div className={`hidden transition-opacity lg:block ${loading || provinceLoading ? 'opacity-40' : ''}`}>
                  <div
                    className="grid min-w-[980px] border-b border-border px-5 py-3 text-left text-xs text-muted-foreground"
                    style={{ gridTemplateColumns: tableGridTemplate }}
                  >
                    <div className="font-medium">套餐</div>
                    <div className="font-medium">月租</div>
                    <div className="font-medium">总流量</div>
                    <div className="font-medium">通用流量</div>
                    <div className="font-medium">定向流量</div>
                    <div className="font-medium">通话</div>
                    <div className="font-medium">限制/合约</div>
                    <div className="font-medium"></div>
                  </div>
                  <VirtualTable
                    plans={visibleTariffs}
                    onSelect={(id) => setSelectedPlanId(id)}
                  />
                </div>
              </Card>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

function VirtualTable({ plans, onSelect }) {
  const parentRef = useRef(null);
  const rowVirtualizer = useVirtualizer({
    count: plans.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 68,
    overscan: 8,
  });

  return (
    <div
      ref={parentRef}
      className="overflow-auto"
      style={{ height: Math.min(plans.length * 68, 600) }}
    >
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
          minWidth: 980,
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const plan = plans[virtualRow.index];
          return (
            <div
              key={plan.id}
              className="absolute left-0 w-full border-b border-border/70 transition-colors hover:bg-accent/35"
              style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
            >
              <div
                className="grid h-full items-center px-5 text-sm"
                style={{ gridTemplateColumns: tableGridTemplate }}
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{plan.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {getPlanTags(plan).map((tag) => (
                      <Badge className="h-5 px-2 text-[11px]" key={tag}>
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="font-mono text-lg font-semibold text-primary">¥{formatPrice(plan.price)}</span>
                </div>
                <div className="font-medium">{formatData(plan.data)}</div>
                <div>{formatData(plan.generalData)}</div>
                <div>{formatData(plan.directedData)}</div>
                <div>{formatVoice(plan.voice)}</div>
                <div className="min-w-0">
                  <div className="truncate">{formatContract(plan.contract)}</div>
                  <p className="mt-0.5 text-xs text-muted-foreground truncate">{plan.audience}</p>
                </div>
                <div className="text-right">
                  <Button className="min-w-14" onClick={() => onSelect(plan.id)} size="sm" type="button" variant="outline">
                    详情
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlanDetail({ onBack, plan }) {
  const [copyStatus, setCopyStatus] = useState('idle');
  const callScript = useMemo(() => buildCallScript(plan), [plan]);

  useEffect(() => {
    setCopyStatus('idle');
  }, [plan.id]);

  const copyCallScript = async () => {
    try {
      await navigator.clipboard.writeText(callScript);
      setCopyStatus('copied');
      window.setTimeout(() => setCopyStatus('idle'), 2000);
    } catch {
      setCopyStatus('failed');
    }
  };

  const detailRows = [
    ['方案编号', plan.details?.schemeId],
    ['资费标准', plan.details?.tariffStandard],
    ['适用地区', plan.details?.applicableArea],
    ['销售渠道', plan.details?.salesChannel],
    ['上线日期', plan.details?.onlineDate],
    ['下线日期', plan.details?.offlineDate],
    ['有效期限', plan.details?.validity],
    ['在网要求', plan.details?.networkRequirement],
    ['退订方式', plan.details?.cancelMethod],
    ['违约责任', plan.details?.liability],
    ['超出资费', plan.details?.overage],
    ['其他服务', plan.details?.services],
    ['其他说明', plan.details?.notes],
  ].filter(([, value]) => value);

  return (
    <section className="grid gap-4">
      <Button className="w-fit" onClick={onBack} type="button" variant="ghost">
        <ArrowLeft className="h-4 w-4" />
        返回列表
      </Button>

      <Card className="overflow-hidden bg-card">
        <CardHeader className="border-b border-border">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-medium text-primary">{plan.area}</p>
              <CardTitle className="mt-1 text-2xl">{plan.name}</CardTitle>
            </div>
            <div className="font-mono text-3xl font-semibold text-primary">¥{formatPrice(plan.price)}</div>
          </div>
        </CardHeader>

        <CardContent className="grid gap-4 p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <DetailMetric label="总流量" value={formatData(plan.data)} />
            <DetailMetric label="通用流量" value={formatData(plan.generalData)} />
            <DetailMetric label="定向流量" value={formatData(plan.directedData)} />
            <DetailMetric label="通话" value={formatVoice(plan.voice)} />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <DetailRow label="宽带" value={plan.broadband} />
            <DetailRow label="短信" value={plan.sms} />
            <DetailRow label="适用人群" value={plan.audience} />
            <DetailRow label="来源" value={plan.source} />
          </div>

          {plan.details?.sourceUrl && (
            <a
              className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
              href={plan.details.sourceUrl}
              rel="noreferrer"
              target="_blank"
            >
              查看运营商官方详情
              <ArrowUpRight className="h-4 w-4" />
            </a>
          )}

          <div className="grid gap-2">
            {detailRows.map(([label, value]) => (
              <DetailRow key={label} label={label} value={value} />
            ))}
          </div>

          <div className="rounded-lg border border-primary/25 bg-primary/5 p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="font-semibold">办理沟通话术</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  已带入公示信息；请客服逐项核验资格，不默认承诺新老用户同权。
                </p>
              </div>
              <Button onClick={copyCallScript} size="sm" type="button" variant="outline">
                {copyStatus === 'copied' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copyStatus === 'copied' ? '已复制' : '复制话术'}
              </Button>
            </div>
            <p className="mt-4 select-text whitespace-pre-line rounded-md border border-border bg-background p-4 text-sm leading-6">
              {callScript}
            </p>
            {copyStatus === 'failed' && (
              <p className="mt-2 text-xs text-destructive">复制失败，请长按或选中文字手动复制。</p>
            )}
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              建议先取得运营商内部投诉工单；对处理结果不满意或运营商未按期答复时，可前往{' '}
              <a
                className="text-primary underline-offset-4 hover:underline"
                href="https://yhssglxt.miit.gov.cn/web/userAppeal/"
                rel="noreferrer"
                target="_blank"
              >
                工信部电信用户申诉受理中心
              </a>
              。
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {getPlanTags(plan).map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function DetailMetric({ label, value }) {
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold">{value}</p>
    </div>
  );
}

function CompactMetric({ label, value }) {
  return (
    <div className="rounded-md border border-border bg-card p-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono font-semibold">{value}</p>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-2 whitespace-pre-line text-sm leading-6">{value}</p>
    </div>
  );
}

function FilterGroup({ label, onChange, options, value }) {
  return (
    <div className="grid gap-2">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div
        className="grid gap-1 rounded-md border border-input bg-background p-1"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => (
          <button
            className={`h-8 rounded-sm px-1 text-xs font-medium transition-colors ${
              value === option.value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            }`}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const rootElement = document.getElementById('root');
const root = window.__taocanRoot ?? createRoot(rootElement);
window.__taocanRoot = root;
root.render(
  <>
    <App />
    <Analytics />
  </>,
);
