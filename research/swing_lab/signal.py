"""Driftline Swing — today's signals for the two live sleeves.

Usage: python research/swing_lab/signal.py   (prints JSON)

Sleeve A: QQQ held while its adjusted close is above the 200-day simple average.
Sleeve B: BTC-USD held while its daily close is above the 50-day simple average.
Both were picked from the backtests in this folder (see README.md); nothing here
places orders.
"""
import datetime as dt
import json
import urllib.request

UA = {"User-Agent": "Mozilla/5.0"}


def _get(url):
    req = urllib.request.Request(url, headers=UA)
    return json.load(urllib.request.urlopen(req, timeout=30))


def yahoo_closes(symbol):
    r = _get(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=2y&interval=1d")
    r = r["chart"]["result"][0]
    adj = r["indicators"]["adjclose"][0]["adjclose"]
    days = [dt.datetime.utcfromtimestamp(t).date().isoformat() for t in r["timestamp"]]
    return [(d, c) for d, c in zip(days, adj) if c]


def coinbase_closes(pair, days=300):
    end = dt.datetime.utcnow()
    start = end - dt.timedelta(days=days - 1)
    r = _get(f"https://api.exchange.coinbase.com/products/{pair}/candles"
             f"?granularity=86400&start={start.isoformat()}&end={end.isoformat()}")
    return sorted((dt.datetime.utcfromtimestamp(t).date().isoformat(), c) for t, _l, _h, _o, c, _v in r)


def sleeve(name, symbol, closes, n):
    xs = [c for _, c in closes]
    avg = sum(xs[-n:]) / n
    last = xs[-1]
    return {
        "sleeve": name,
        "symbol": symbol,
        "as_of": closes[-1][0],
        "close": round(last, 4),
        f"sma{n}": round(avg, 4),
        "distance_pct": round((last / avg - 1) * 100, 2),
        "signal": "HOLD" if last > avg else "CASH",
    }


def main():
    out = [
        sleeve("A", "QQQ", yahoo_closes("QQQ"), 200),
        sleeve("B", "BTC-USD", coinbase_closes("BTC-USD"), 50),
    ]
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
