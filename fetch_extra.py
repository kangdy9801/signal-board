"""신호표에 필요한데 macro-dashboard에 없는 데이터를 받아 data/extra.json 으로 저장합니다.
(GitHub Actions에서 매일 실행)

- 코스피, AI 관련 ETF: Yahoo Finance (yfinance), 최근 3년 일봉 종가
- S&P 500 이익수익률: multpl.com 월별 표 → 실패 시 SPY의 PER로 계산(100 ÷ PER)
- 빅테크 4곳 분기별 설비투자: SEC EDGAR 공시 재무제표(현금흐름표의 유형자산 취득액)
받기에 실패한 항목은 지난 데이터를 그대로 둡니다.
"""
import datetime as dt
import io
import json
import os
import time

import pandas as pd
import requests
import yfinance as yf

OUT = os.path.join(os.path.dirname(__file__), "..", "data", "extra.json")
START = (dt.date.today() - dt.timedelta(days=365 * 3)).isoformat()
HEADERS = {"User-Agent": "Mozilla/5.0 (signal-board; GitHub Actions)"}

# SEC는 요청마다 연락처가 담긴 User-Agent를 요구합니다. 본인 이메일로 바꿔 두세요.
SEC_HEADERS = {"User-Agent": "signal-board personal-use contact@example.com"}
# (id, 이름, SEC CIK)
BIGTECH = [
    ("msft", "마이크로소프트", "0000789019"),
    ("googl", "알파벳", "0001652044"),
    ("amzn", "아마존", "0001018724"),
    ("meta", "메타", "0001326801"),
]
# 현금흐름표의 설비투자 항목 이름 후보 (회사마다 다름. 가장 최근 값이 있는 것을 씀)
CAPEX_TAGS = ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"]

# (id, 제목, 후보 티커들 - 앞에서부터 시도)
# AI 관련 주식은 실제로 보유한 ETF나 종목의 티커로 바꿔도 됩니다. (예: "SMH", "SOXX", "BOTZ")
YAHOO = [
    ("kospi", "코스피", ["^KS11"]),
    ("ai", "AI 관련 주식 (SMH)", ["SMH"]),
]


def from_yahoo(tickers):
    for t in tickers:
        try:
            df = yf.download(t, start=START, progress=False, auto_adjust=False)
            if df is None or df.empty:
                print(f"[yahoo] {t}: 데이터 없음")
                continue
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)
            rows = [
                {"time": idx.strftime("%Y-%m-%d"), "close": round(float(v), 4)}
                for idx, v in df["Close"].dropna().items()
            ]
            print(f"[yahoo] {t}: {len(rows)}일")
            return t, rows
        except Exception as e:
            print(f"[yahoo] {t}: 실패 {e}")
    return None, []


def ey_from_multpl():
    url = "https://www.multpl.com/s-p-500-earnings-yield/table/by-month"
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    table = pd.read_html(io.StringIO(r.text))[0]
    date_s, value_s = str(table.iloc[0, 0]), str(table.iloc[0, 1])
    value = float(value_s.replace("%", "").replace("estimate", "").strip())
    as_of = pd.to_datetime(date_s).strftime("%Y-%m-%d")
    return {"value": round(value, 2), "as_of": as_of, "source": "multpl.com (최근 12개월 실적 기준)"}


def ey_from_spy():
    pe = yf.Ticker("SPY").info.get("trailingPE")
    if not pe:
        raise ValueError("SPY PER 없음")
    return {"value": round(100 / float(pe), 2), "as_of": dt.date.today().isoformat(),
            "source": "Yahoo Finance SPY PER로 계산"}


def _days(a, b):
    return (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days


def quarterly_from_facts(facts):
    """공시 값(분기 단독 또는 연초 누적)을 분기별 금액으로 바꿉니다."""
    latest = {}
    for f in facts:
        if f.get("form") not in ("10-Q", "10-K", "10-Q/A", "10-K/A") or "start" not in f:
            continue
        key = (f["start"], f["end"])
        if key not in latest or f.get("filed", "") > latest[key].get("filed", ""):
            latest[key] = f
    quarters = {}
    # 1) 3개월짜리 값은 그대로
    for (start, end), f in latest.items():
        if 80 <= _days(start, end) <= 100:
            quarters[end] = float(f["val"])
    # 2) 같은 시작일의 누적 값끼리 빼서 남은 분기 계산
    by_start = {}
    for (start, end), f in latest.items():
        by_start.setdefault(start, []).append((end, float(f["val"])))
    for start, rows in by_start.items():
        rows.sort()
        for i in range(1, len(rows)):
            (pe, pv), (e, v) = rows[i - 1], rows[i]
            if 80 <= _days(pe, e) <= 100 and e not in quarters:
                quarters[e] = v - pv
    return [{"end": e, "value": round(v / 1e9, 2)} for e, v in sorted(quarters.items())]


def capex_for(cik):
    url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
    r = requests.get(url, headers=SEC_HEADERS, timeout=60)
    r.raise_for_status()
    gaap = r.json().get("facts", {}).get("us-gaap", {})
    best = None
    for tag in CAPEX_TAGS:
        facts = gaap.get(tag, {}).get("units", {}).get("USD", [])
        q = quarterly_from_facts(facts)
        if q and (best is None or q[-1]["end"] > best[1][-1]["end"]):
            best = (tag, q)
    if not best:
        raise ValueError("설비투자 항목을 찾지 못함")
    return best[0], best[1][-12:]


def fetch_capex(old_capex):
    old_by_id = {c["id"]: c for c in (old_capex or {}).get("companies", [])}
    companies = []
    for cid, name, cik in BIGTECH:
        try:
            tag, quarters = capex_for(cik)
            companies.append({"id": cid, "name": name, "tag": tag, "quarters": quarters})
            print(f"[sec] {name}: {tag}, 최근 {quarters[-1]}")
        except Exception as e:
            print(f"[sec] {name}: 실패 {e}")
            if cid in old_by_id:
                companies.append(old_by_id[cid])
        time.sleep(0.5)  # SEC 요청 간격
    return {"source": "SEC EDGAR 현금흐름표 (유형자산 취득, 금융리스 제외)", "companies": companies} if companies else old_capex


def main():
    old = {}
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                old = json.load(f)
        except Exception:
            old = {}
    old_series = {s["id"]: s for s in old.get("series", [])}

    series = []
    for sid, title, tickers in YAHOO:
        used, rows = from_yahoo(tickers)
        if rows:
            series.append({"id": sid, "title": title, "source": f"Yahoo Finance {used}", "data": rows})
        elif sid in old_series:
            print(f"{sid}: 이번에 못 받아서 지난 데이터를 유지합니다")
            series.append(old_series[sid])

    ey = None
    for fn in (ey_from_multpl, ey_from_spy):
        try:
            ey = fn()
            print("이익수익률:", ey)
            break
        except Exception as e:
            print(f"이익수익률 {fn.__name__} 실패: {e}")
    if ey is None:
        ey = old.get("earnings_yield")

    capex = fetch_capex(old.get("capex"))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
                   "series": series, "earnings_yield": ey, "capex": capex}, f, ensure_ascii=False)
    print("저장 완료:", OUT)


if __name__ == "__main__":
    main()
