"""신호표에 필요한데 macro-dashboard에 없는 데이터를 받아 data/extra.json 으로 저장합니다.
(GitHub Actions에서 매일 실행)

- 코스피, 비트코인, AI 관련 ETF: Yahoo Finance (yfinance), 최근 3년 일봉 종가
- S&P 500 이익수익률: multpl.com 월별 표 → 실패 시 SPY의 PER로 계산(100 ÷ PER)
받기에 실패한 항목은 지난 데이터를 그대로 둡니다.
"""
import datetime as dt
import io
import json
import os

import pandas as pd
import requests
import yfinance as yf

OUT = os.path.join(os.path.dirname(__file__), "..", "data", "extra.json")
START = (dt.date.today() - dt.timedelta(days=365 * 3)).isoformat()
HEADERS = {"User-Agent": "Mozilla/5.0 (signal-board; GitHub Actions)"}

# (id, 제목, 후보 티커들 - 앞에서부터 시도)
# AI 관련 주식은 실제로 보유한 ETF나 종목의 티커로 바꿔도 됩니다. (예: "SMH", "SOXX", "BOTZ")
YAHOO = [
    ("kospi", "코스피", ["^KS11"]),
    ("btc", "비트코인 (달러)", ["BTC-USD"]),
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

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
                   "series": series, "earnings_yield": ey}, f, ensure_ascii=False)
    print("저장 완료:", OUT)


if __name__ == "__main__":
    main()
