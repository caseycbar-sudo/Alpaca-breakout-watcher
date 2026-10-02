"""Driftline Swing — today's signals for the two live sleeves.

Usage: python research/swing_lab/signal.py [--qqq 200] [--btc 50]   (prints JSON)

The lengths come from the Settings tab of the "Driftline Swing Watchdog" Google Sheet;
they must stay inside the lab-tested ranges below or the defaults are used.

Sleeve A: QQQ held while its adjusted close is above the 200-day simple average.
Sleeve B: BTC-USD held while its daily close is above the 50-day simple average.
Both were picked from the backtests in this folder (see README.md); nothing here
places orders.
"""
import argparse
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
        "length": n,
        "average": round(avg, 4),
        "distance_pct": round((last / avg - 1) * 100, 2),
        "signal": "HOLD" if last > avg else "CASH",
    }


ALLOWED = {"qqq": (100, 250, 200), "btc": (30, 200, 50)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--qqq", type=int, default=200)
    ap.add_argument("--btc", type=int, default=50)
    args = ap.parse_args()
    lengths = {}
    for k, (lo, hi, default) in ALLOWED.items():
        n = getattr(args, k)
        lengths[k] = n if lo <= n <= hi else default
    out = [
        sleeve("A", "QQQ", yahoo_closes("QQQ"), lengths["qqq"]),
        sleeve("B", "BTC-USD", coinbase_closes("BTC-USD"), lengths["btc"]),
    ]
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
