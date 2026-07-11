#!/usr/bin/env python3
"""通过已通过安全校验的 Chrome 会话抓取中国电信集团资费专区。"""

import html
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import websocket


CDP_PORT = int(os.environ.get("CDP_PORT", "9224"))
BASE_URL = "https://www.189.cn/jtzfzq/"
API_ROOT = "https://www.189.cn/bss/tariffZone"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "data", "telecom")
SEARCH_TERMS = ["套餐", "5G", "4G", "星卡", "畅享", "流量", "元", "校园", "关爱", "无忧"]

PROVINCES = {
    "北京": "609001", "天津": "609902", "河北": "609906", "山西": "609907",
    "内蒙古": "609908", "辽宁": "609905", "吉林": "609909", "黑龙江": "609910",
    "上海": "600102", "江苏": "600103", "浙江": "600104", "安徽": "600301",
    "福建": "600105", "江西": "600305", "山东": "609903", "河南": "609904",
    "湖北": "600202", "湖南": "600203", "广东": "600101", "广西": "600302",
    "海南": "600403", "重庆": "600304", "四川": "600201", "贵州": "600402",
    "云南": "600205", "西藏": "600406", "陕西": "600204", "甘肃": "600401",
    "青海": "600405", "宁夏": "600404", "新疆": "600303",
}

POSITIVE = re.compile(r"套餐|星卡|无忧卡|孝心卡|关爱|青春卡|校园卡")
EXCLUDE = re.compile(r"宽带|融合|电视|固话|企业|ICT|云业务|云看家|专线|折扣|减免|优惠活动|礼包|副卡|加装包|靓号|号码|橙分期|红包|购机|终端")


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, max_size=None, timeout=10)
        self.mid = 0
        self.lock = threading.Lock()

    def evaluate(self, expression):
        with self.lock:
            self.mid += 1
            mid = self.mid
            self.ws.send(json.dumps({
                "id": mid,
                "method": "Runtime.evaluate",
                "params": {"expression": expression, "returnByValue": True, "awaitPromise": True},
            }))
            while True:
                message = json.loads(self.ws.recv())
                if message.get("id") == mid:
                    result = message.get("result", {}).get("result", {})
                    if result.get("subtype") == "error":
                        raise RuntimeError(result.get("description", "浏览器执行失败"))
                    return result.get("value")


def connect():
    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json"))
    target = next((
        item for item in targets
        if item.get("type") == "page" and item.get("url", "").startswith("https://www.189.cn/jtzfzq")
    ), None)
    if not target:
        raise RuntimeError(f"端口 {CDP_PORT} 没有已打开的中国电信资费专区页面")
    return CDP(target["webSocketDebuggerUrl"])


def open_tab(url):
    request = urllib.request.Request(
        f"http://127.0.0.1:{CDP_PORT}/json/new?{urllib.parse.quote(url, safe=':/?=&')}",
        method="PUT",
    )
    target = json.load(urllib.request.urlopen(request, timeout=10))
    return CDP(target["webSocketDebuggerUrl"]), target["id"]


def close_tab(target_id):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/close/{target_id}").read()
    except Exception:
        pass


def api(cdp, path, params):
    query = "&".join(f"{key}={urllib.parse.quote(str(value))}" for key, value in params.items())
    url = f"{API_ROOT}/{path}?{query}"
    expression = f"""
      fetch({json.dumps(url)}, {{credentials: 'include'}})
        .then(async response => ({{status: response.status, text: await response.text()}}))
    """
    response = cdp.evaluate(expression)
    if response["status"] != 200:
        raise RuntimeError(f"{path}: HTTP {response['status']}")
    payload = json.loads(response["text"])
    if payload.get("code") != "0":
        raise RuntimeError(f"{path}: {payload.get('message') or payload.get('msg') or payload.get('code')}")
    return payload.get("dataObject")


def plain(value):
    value = re.sub(r"<br\s*/?>", "\n", value or "", flags=re.I)
    value = re.sub(r"</(?:p|div|tr|li)>", "\n", value, flags=re.I)
    value = re.sub(r"<[^>]+>", " ", value)
    value = html.unescape(value).replace("\xa0", " ")
    return "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in value.splitlines() if line.strip())


def first_number(pattern, value):
    match = re.search(pattern, value, re.I)
    return float(match.group(1)) if match else 0


def price_from(value):
    values = [float(item) for item in re.findall(r"(?<!\d)(\d+(?:\.\d+)?)\s*元", value)]
    values = [item for item in values if 0 < item < 1000]
    return values[0] if values else 0


def metric(value, unit):
    number = first_number(rf"(\d+(?:\.\d+)?)\s*{unit}", value)
    return int(number) if float(number).is_integer() else number


def data_metric(value):
    return metric(value, r"(?:GB|G(?=流量))")


def labeled(text, label):
    match = re.search(rf"{label}\s*[：:]\s*\n?([^\n]+)", text)
    return match.group(1).strip() if match else ""


def traffic_gb(value):
    match = re.search(r"(\d+(?:\.\d+)?)\s*(GB|G|MB|M)\b", value or "", re.I)
    if not match:
        return 0
    number = float(match.group(1))
    if match.group(2).upper() in ("MB", "M"):
        number /= 1024
    return round(number, 2)


def service_values(text):
    match = re.search(r"服务内容\s*\n(.*?)(?:\n超出资费|\n其他服务内容|\n其他事项|$)", text, re.S)
    if not match:
        return None
    section = match.group(1).strip()
    lines = [line.strip() for line in section.splitlines() if line.strip()]
    for index, line in enumerate(lines[:-1]):
        if "通用流量" not in line or "定向流量" not in line:
            continue
        headers = re.split(r"\s+", line)
        values = re.split(r"\s+", lines[index + 1])
        if len(values) < len(headers):
            continue
        row = dict(zip(headers, values))
        voice_text = row.get("语音", "")
        voice = metric(voice_text, "分钟")
        if not voice:
            voice = first_number(r"(\d+(?:\.\d+)?)", voice_text)
        return {
            "general": traffic_gb(row.get("通用流量")),
            "directed": traffic_gb(row.get("定向流量")),
            "voice": voice,
            "sms": row.get("短信", ""),
            "broadband": row.get("带宽", ""),
        }
    general = re.search(r"通用流量\s*[：:]?\s*(\d+(?:\.\d+)?\s*(?:GB|G|MB|M))", section, re.I)
    directed = re.search(r"定向流量\s*[：:]?\s*(\d+(?:\.\d+)?\s*(?:GB|G|MB|M))", section, re.I)
    voice = re.search(r"语音\s*[：:]?\s*(\d+(?:\.\d+)?)\s*分钟", section)
    if general or directed or voice or "通用流量" in section:
        return {
            "general": traffic_gb(general.group(1) if general else ""),
            "directed": traffic_gb(directed.group(1) if directed else ""),
            "voice": float(voice.group(1)) if voice else 0,
            "sms": "",
            "broadband": "",
        }
    return None


def enrich_from_text(plan, body):
    services = service_values(body)
    scheme_id = plan.get("details", {}).get("schemeId", "")
    if not services or (scheme_id and scheme_id not in body):
        return None
    general = services["general"]
    directed = services["directed"]
    plan["generalData"] = general
    plan["directedData"] = directed
    plan["data"] = round(general + directed, 2)
    plan["voice"] = services["voice"]
    if not plan["data"] and not plan["voice"] and not re.search(r"保号|无忧", plan["name"]):
        return None
    plan["sms"] = services["sms"] or "以官方详情为准"
    plan["broadband"] = services["broadband"] or "以官方详情为准"
    plan["audience"] = labeled(body, "适用范围") or plan["audience"]
    plan["contract"] = labeled(body, "有效期限") or plan["contract"]
    details = plan["details"]
    details.update({
        "tariffStandard": labeled(body, "资费标准") or details.get("tariffStandard", ""),
        "applicableArea": plan["audience"],
        "salesChannel": labeled(body, "销售渠道"),
        "validity": plan["contract"],
        "networkRequirement": labeled(body, "在网要求"),
        "cancelMethod": labeled(body, "退订方式"),
        "liability": labeled(body, "违约责任"),
        "overage": labeled(body, "超出资费"),
        "verified": True,
    })
    return plan


def fetch_detail(plan):
    if urllib.parse.urlparse(plan["details"]["sourceUrl"]).hostname == "gd.189.cn":
        try:
            report_no = plan["details"]["schemeId"]
            url = f"https://gd.189.cn/gdzfzq/detailzf/{urllib.parse.quote(report_no)}.json"
            payload = json.load(urllib.request.urlopen(url, timeout=15))
            item = payload.get("r", {}).get("r01") or {}
            if str(item.get("r0107")) != "1":
                return None
            general = traffic_gb(f"{item.get('r0119', '')}{item.get('r0120', '')}")
            directed = traffic_gb(f"{item.get('r0121', '')}{item.get('r0122', '')}")
            plan.update({
                "generalData": general,
                "directedData": directed,
                "data": round(general + directed, 2),
                "voice": float(item.get("r0123") or 0),
                "sms": item.get("r0124") or "以官方详情为准",
                "broadband": item.get("r0125") or "以官方详情为准",
                "audience": item.get("r0110") or plan["audience"],
                "contract": item.get("r0114") or plan["contract"],
            })
            if not plan["data"] and not plan["voice"] and not re.search(r"保号|无忧", plan["name"]):
                return None
            plan["details"].update({
                "tariffStandard": f"{item.get('r0108', '')}{item.get('r0109', '')}",
                "applicableArea": plan["audience"],
                "salesChannel": item.get("r0111") or "",
                "validity": plan["contract"],
                "networkRequirement": item.get("r0116") or "",
                "cancelMethod": item.get("r0115") or "",
                "liability": item.get("r0117") or "",
                "overage": item.get("r0133") or "",
                "services": item.get("r0127") or "",
                "notes": item.get("r0130") or "",
                "verified": True,
            })
            return plan
        except Exception:
            return None
    cdp, target_id = open_tab(plan["details"]["sourceUrl"])
    try:
        body = ""
        for _ in range(30):
            time.sleep(0.5)
            body = cdp.evaluate("document.body ? document.body.innerText : ''") or ""
            if len(body) > 200 and (plan["details"]["schemeId"] in body or plan["name"] in body):
                break
        return enrich_from_text(plan, body)
    except Exception:
        return None
    finally:
        close_tab(target_id)


def enrich_details(provinces):
    force = "--force" in sys.argv
    for province in provinces:
        path = os.path.join(OUTPUT_DIR, f"{province}.json")
        with open(path, encoding="utf-8") as source:
            payload = json.load(source)
        pending = [plan for plan in payload["plans"] if force or not plan.get("details", {}).get("verified")]
        verified = [] if force else [
            plan for plan in payload["plans"]
            if plan.get("details", {}).get("verified")
            and (plan.get("data") or plan.get("voice") or re.search(r"保号|无忧", plan["name"]))
        ]
        with ThreadPoolExecutor(max_workers=6) as executor:
            futures = [executor.submit(fetch_detail, plan) for plan in pending]
            for future in as_completed(futures):
                plan = future.result()
                if plan:
                    verified.append(plan)
        verified.sort(key=lambda plan: (plan["price"], plan["name"]))
        write_json(path, {"area": province, "plans": verified})
        print(f"{province}: 详情核验 {len(verified)}/{len(payload['plans'])}")


def merge_verified(source_dir):
    for province in PROVINCES:
        current_path = os.path.join(OUTPUT_DIR, f"{province}.json")
        saved_path = os.path.join(source_dir, f"{province}.json")
        with open(current_path, encoding="utf-8") as source:
            current = json.load(source)
        with open(saved_path, encoding="utf-8") as source:
            saved = json.load(source)
        saved_by_id = {plan["id"]: plan for plan in saved["plans"] if plan.get("details", {}).get("verified")}
        current["plans"] = [saved_by_id.get(plan["id"], plan) for plan in current["plans"]]
        write_json(current_path, current)


def prune_unverified():
    for province in PROVINCES:
        path = os.path.join(OUTPUT_DIR, f"{province}.json")
        with open(path, encoding="utf-8") as source:
            payload = json.load(source)
        payload["plans"] = [
            plan for plan in payload["plans"]
            if plan.get("details", {}).get("verified")
            and (plan.get("data") or plan.get("voice") or re.search(r"保号|无忧", plan["name"]))
        ]
        write_json(path, payload)


def rebuild_index():
    counts = {}
    for province in PROVINCES:
        path = os.path.join(OUTPUT_DIR, f"{province}.json")
        with open(path, encoding="utf-8") as source:
            counts[province] = len(json.load(source)["plans"])
    write_json(os.path.join(OUTPUT_DIR, "national.json"), {"area": "全国", "plans": []})
    available = [province for province in PROVINCES if counts[province] > 0]
    write_json(os.path.join(OUTPUT_DIR, "index.json"), {
        "sourceUrl": BASE_URL,
        "sourceName": "中国电信资费专区",
        "updatedAt": "2026-07-11",
        "planCount": sum(counts.values()),
        "nationalPlanCount": 0,
        "provincePlanCounts": counts,
        "provinces": available,
        "unavailableProvinces": [province for province in PROVINCES if counts[province] == 0],
        "methodology": "逐条读取中国电信各省官方资费详情页；仅展示已核验服务内容的记录。中国电信未在集团专区公示全国基础套餐，因此按省展示。",
    })


def normalize_search(item, province):
    name = (item.get("title") or "").strip()
    price = price_from(name)
    if not name or not price or not POSITIVE.search(name) or EXCLUDE.search(name):
        return None
    report_no = (item.get("records") or item.get("nbr") or item.get("id") or "").strip()
    source_url = (item.get("wt_url") or item.get("app_url") or BASE_URL).strip()
    return {
        "id": f"telecom-{province}-{report_no or item.get('id')}",
        "name": name,
        "area": province,
        "price": price,
        "data": data_metric(name),
        "generalData": data_metric(name),
        "directedData": 0,
        "voice": metric(name, "分钟"),
        "sms": "详见官方详情",
        "broadband": "详见官方详情",
        "audience": "以当地电信办理规则为准",
        "contract": "详见官方详情",
        "source": "中国电信资费专区",
        "tags": ["套餐", "移网", "本省资费"],
        "details": {
            "schemeId": report_no,
            "tariffStandard": f"{price:g}元/月（标题提取，详见官方详情）",
            "onlineDate": item.get("begin_time") or "",
            "offlineDate": item.get("end_time") or "",
            "category": "套餐",
            "sourceUrl": source_url,
            "notes": "省级统一索引仅公示摘要字段，具体流量、通话、适用对象及合约条件请查看官方详情。",
        },
    }


def normalize_national(item):
    name = (item.get("name") or "").strip()
    content = "\n".join(filter(None, [name, plain(item.get("jbxx")), plain(item.get("ffnr")), plain(item.get("other_content"))]))
    price = price_from(content)
    if not name or not price:
        return None
    report_no = (item.get("report_no") or item.get("id") or "").strip()
    is_activity = bool(re.search(r"合约|优惠|折扣|促销", name))
    category = "活动" if is_activity else "套餐"
    return {
        "id": f"telecom-national-{report_no or item.get('id')}",
        "name": name,
        "area": "全国",
        "price": price,
        "data": data_metric(content),
        "generalData": data_metric(content),
        "directedData": 0,
        "voice": metric(content, "分钟"),
        "sms": "详见资费说明",
        "broadband": "详见资费说明",
        "audience": "以官方公示为准",
        "contract": "详见资费说明",
        "source": "中国电信资费专区",
        "tags": [category, "集团资费"],
        "details": {
            "schemeId": report_no,
            "tariffStandard": content[:8000],
            "category": category,
            "sourceUrl": BASE_URL,
            "notes": plain(item.get("others")),
        },
    }


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write("\n")


def main():
    if "--probe-url" in sys.argv:
        index = sys.argv.index("--probe-url")
        cdp, _ = open_tab(sys.argv[index + 1])
        time.sleep(8)
        print(cdp.evaluate("JSON.stringify({url:location.href,title:document.title,text:document.body.innerText.slice(0,12000)})"))
        return
    if "--enrich-details" in sys.argv:
        requested = [item for item in sys.argv[sys.argv.index("--enrich-details") + 1:] if not item.startswith("--")]
        provinces = requested or list(PROVINCES)
        enrich_details(provinces)
        rebuild_index()
        return
    if "--merge-verified" in sys.argv:
        merge_verified(sys.argv[sys.argv.index("--merge-verified") + 1])
        rebuild_index()
        return
    if "--prune-unverified" in sys.argv:
        prune_unverified()
        rebuild_index()
        return
    cdp = connect()
    if "--probe-catalogs" in sys.argv:
        for province, code in PROVINCES.items():
            catalog = api(cdp, "tarifZone12List.do", {"provCode": code}) or []
            print(province, json.dumps(catalog, ensure_ascii=False)[:800])
        return
    if "--probe-titles" in sys.argv:
        for province, code in PROVINCES.items():
            items = api(cdp, "tarifZone3Title.do", {
                "provCode": code, "lable1Id": "671af00f114dd43fc66375b9",
            }) or []
            print(province, len(items), json.dumps(items[:1], ensure_ascii=False)[:1600])
        return
    national_items = api(cdp, "tarifZone3Title.do", {
        "provCode": "1000000037", "lable1Id": "671af00f114dd43fc66375b9",
    }) or []
    national = [plan for item in national_items if (plan := normalize_national(item))]
    write_json(os.path.join(OUTPUT_DIR, "national.json"), {"area": "全国", "plans": national})

    province_counts = {}
    for province, code in PROVINCES.items():
        merged = {}
        for term in SEARCH_TERMS:
            result = api(cdp, "tarifZoneEs.do", {"provinceCode": code, "query": term}) or {}
            for item in result.get("data", []):
                plan = normalize_search(item, province)
                if plan:
                    merged[plan["id"]] = plan
        plans = sorted(merged.values(), key=lambda plan: (plan["price"], plan["name"]))
        province_counts[province] = len(plans)
        write_json(os.path.join(OUTPUT_DIR, f"{province}.json"), {"area": province, "plans": plans})
        print(f"{province}: {len(plans)}")

    total = len(national) + sum(province_counts.values())
    index = {
        "sourceUrl": BASE_URL,
        "sourceName": "中国电信资费专区",
        "updatedAt": "2026-07-11",
        "planCount": total,
        "nationalPlanCount": len(national),
        "provincePlanCounts": province_counts,
        "provinces": list(PROVINCES),
        "methodology": "集团资费来自集团目录；省级资费来自中国电信统一资费搜索索引，详情字段以官方链接为准。",
    }
    write_json(os.path.join(OUTPUT_DIR, "index.json"), index)
    print(f"全国: {len(national)}；合计: {total}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"抓取失败：{error}", file=sys.stderr)
        sys.exit(1)
