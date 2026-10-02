import json,urllib.request,time,datetime as dt,os
UA={'User-Agent':'Mozilla/5.0'}
def get(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=30))
os.makedirs('data',exist_ok=True)
for s in ['SPY','QQQ','IWM','EFA','EEM','TLT','IEF','GLD','DBC','VNQ','XLK','XLE','XLV','XLF','XLI','XLY','XLP','XLU','SHY']:
    d=get(f'https://query1.finance.yahoo.com/v8/finance/chart/{s}?range=20y&interval=1d&events=div,split')['chart']['result'][0]
    q=d['indicators']['quote'][0]; adj=d['indicators']['adjclose'][0]['adjclose']
    rows=[(dt.datetime.utcfromtimestamp(t).date().isoformat(),o,h,l,c,a) for t,o,h,l,c,a in zip(d['timestamp'],q['open'],q['high'],q['low'],q['close'],adj) if c]
    json.dump(rows,open(f'data/{s}.json','w')); print(s,len(rows),rows[0][0])
for p in ['BTC-USD','ETH-USD','SOL-USD','LTC-USD','LINK-USD','XRP-USD','DOGE-USD','AVAX-USD','BCH-USD','UNI-USD']:
    end=dt.datetime(2026,10,2); out={}
    while True:
        start=end-dt.timedelta(days=299)
        r=get(f'https://api.exchange.coinbase.com/products/{p}/candles?granularity=86400&start={start.isoformat()}&end={end.isoformat()}')
        if not r: break
        for t,l,h,o,c,v in r: out[t]=(dt.datetime.utcfromtimestamp(t).date().isoformat(),o,h,l,c,c)
        end=start; time.sleep(0.35)
        if start.year<2015: break
    rows=[out[k] for k in sorted(out)]
    json.dump(rows,open(f'data/{p}.json','w')); print(p,len(rows),rows[0][0])
