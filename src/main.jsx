import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowUpRight,
  ArrowLeft,
  ChevronDown,
  LocateFixed,
  ListFilter,
  Moon,
  Sun,
  Zap,
} from 'lucide-react';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { provinceCenters, tariffMetadata, tariffs, tariffSourceUrl } from './data/tariffs';
import './styles.css';

const areas = Object.keys(provinceCenters);
const primaryCategories = ['套餐', '号卡'];

function formatData(value) {
  return value > 0 ? `${value}GB` : '-';
}

function formatVoice(value) {
  return value > 0 ? `${value} 分钟` : '-';
}

function formatPrice(value) {
  return Number.isInteger(value) ? value : value.toFixed(2);
}

function planMatchesArea(plan, area) {
  return plan.area === area || plan.area === '全国' || plan.details?.applicableArea?.includes(area);
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
  const [selectedArea, setSelectedArea] = useState('北京');
  const [maxPrice, setMaxPrice] = useState(100);
  const [minimumData, setMinimumData] = useState(30);
  const [categoryFilter, setCategoryFilter] = useState('primary');
  const [locationStatus, setLocationStatus] = useState('默认展示北京，可手动切换地区');
  const [selectedPlanId, setSelectedPlanId] = useState(null);

  const visibleTariffs = useMemo(() => {
    return tariffs
      .filter((plan) => planMatchesArea(plan, selectedArea))
      .filter((plan) =>
        categoryFilter === 'all' ? true : primaryCategories.includes(plan.details?.category),
      )
      .filter((plan) => plan.price <= maxPrice)
      .filter((plan) => plan.data >= minimumData)
      .sort((a, b) => a.price - b.price || b.data - a.data);
  }, [categoryFilter, maxPrice, minimumData, selectedArea]);

  const selectedPlan = useMemo(() => tariffs.find((plan) => plan.id === selectedPlanId), [selectedPlanId]);

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

  return (
    <main className={theme}>
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <header className="sticky top-0 z-20 flex flex-col gap-3 border-b border-border bg-background/92 px-0 py-3 backdrop-blur md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
                <Zap className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">中国移动公开资费</p>
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
                  {areas.map((area) => (
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
              <a
                className="hidden h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:inline-flex"
                href={tariffSourceUrl}
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

          {selectedPlan ? (
            <PlanDetail plan={selectedPlan} onBack={() => setSelectedPlanId(null)} />
          ) : (
            <section className="grid gap-4">
              <Card className="bg-card">
                <CardContent className="grid gap-4 p-3 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
                  <FilterGroup
                    label="类型"
                    onChange={setCategoryFilter}
                    options={[
                      { label: '套餐/号卡', value: 'primary' },
                      { label: '全部', value: 'all' },
                    ]}
                    value={categoryFilter}
                  />
                  <FilterGroup
                    label="最高月租"
                    onChange={setMaxPrice}
                    options={[
                      { label: '30 元', value: 30 },
                      { label: '50 元', value: 50 },
                      { label: '70 元', value: 70 },
                      { label: '100 元', value: 100 },
                      { label: '不限', value: 999 },
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
                      { label: '100GB', value: 100 },
                    ]}
                    value={minimumData}
                  />
                  <div className="flex h-10 items-center gap-2 rounded-md border border-border px-3 text-sm text-muted-foreground" title={`本地已抓取 ${tariffMetadata.planCount} 条，接口失败 ${tariffMetadata.failureCount} 条`}>
                    <ListFilter className="h-4 w-4" />
                    {visibleTariffs.length} 个
                  </div>
                </CardContent>
              </Card>

              <Card className="overflow-hidden bg-card">
                <CardHeader className="flex-row items-center justify-between gap-3 border-b border-border">
                  <div>
                    <p className="text-xs font-medium text-primary">{selectedArea}</p>
                    <CardTitle>公开资费列表</CardTitle>
                  </div>
                  <Badge>{visibleTariffs.length} 个套餐</Badge>
                </CardHeader>
                <div className="grid gap-3 p-3 lg:hidden">
                  {visibleTariffs.map((plan) => (
                    <article className="rounded-lg border border-border bg-background p-4" key={plan.id}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-medium leading-6">{plan.name}</h3>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {plan.tags.map((tag) => (
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
                        <p className="text-xs text-muted-foreground">{plan.contract}</p>
                        <Button onClick={() => setSelectedPlanId(plan.id)} size="sm" type="button" variant="outline">
                          详情
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>

                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full min-w-[980px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="px-5 py-3 font-medium">套餐</th>
                        <th className="px-5 py-3 font-medium">月租</th>
                        <th className="px-5 py-3 font-medium">总流量</th>
                        <th className="px-5 py-3 font-medium">通用流量</th>
                        <th className="px-5 py-3 font-medium">定向流量</th>
                        <th className="px-5 py-3 font-medium">语音</th>
                        <th className="px-5 py-3 font-medium">限制/合约</th>
                        <th className="px-5 py-3 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTariffs.map((plan) => (
                        <tr className="border-b border-border/70 transition-colors hover:bg-accent/35" key={plan.id}>
                          <td className="px-5 py-4">
                            <div className="font-medium">{plan.name}</div>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {plan.tags.map((tag) => (
                                <Badge className="h-5 px-2 text-[11px]" key={tag}>
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          </td>
                          <td className="px-5 py-4">
                            <span className="font-mono text-lg font-semibold text-primary">¥{formatPrice(plan.price)}</span>
                          </td>
                          <td className="px-5 py-4 font-medium">{formatData(plan.data)}</td>
                          <td className="px-5 py-4">{formatData(plan.generalData)}</td>
                          <td className="px-5 py-4">{formatData(plan.directedData)}</td>
                          <td className="px-5 py-4">{formatVoice(plan.voice)}</td>
                          <td className="px-5 py-4">
                            <div>{plan.contract}</div>
                            <p className="mt-1 text-xs text-muted-foreground">{plan.audience}</p>
                          </td>
                          <td className="px-5 py-4 text-right">
                            <Button onClick={() => setSelectedPlanId(plan.id)} size="sm" type="button" variant="outline">
                              详情
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

function PlanDetail({ onBack, plan }) {
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
            <DetailMetric label="语音" value={formatVoice(plan.voice)} />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <DetailRow label="宽带" value={plan.broadband} />
            <DetailRow label="短信" value={plan.sms} />
            <DetailRow label="适用人群" value={plan.audience} />
            <DetailRow label="来源" value={plan.source} />
          </div>

          <div className="grid gap-2">
            {detailRows.map(([label, value]) => (
              <DetailRow key={label} label={label} value={value} />
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {plan.tags.map((tag) => (
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
root.render(<App />);
