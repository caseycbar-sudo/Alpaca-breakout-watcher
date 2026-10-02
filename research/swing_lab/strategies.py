import json,sys
from bt import run,sma,rsi
R=[]
def rec(name,r): r['name']=name; R.append(r); print(json.dumps(r))
ETF_COST=0.0003   # ~half-spread+slippage on liquid ETFs, Robinhood has no commission
C_TAKER=0.0095+0.0002; C_MAKER=0.005+0.0002
# S0 buy & hold
rec('SPY buy & hold',run(['SPY'],lambda s,j,c:('buy',0) if s not in c['pos'] else None,slots=1,cost=ETF_COST))
# S1 200-day trend filter
def trend(n):
    def f(s,j,c):
        x=c['ser'][s]['c']; m=sma(x,n,j)
        if m is None: return None
        return ('buy',0) if x[j]>m else 'sell'
    return f
rec('SPY 200d trend filter',run(['SPY'],trend(200),slots=1,cost=ETF_COST))
rec('QQQ 200d trend filter',run(['QQQ'],trend(200),slots=1,cost=ETF_COST))
# S2 RSI(2) mean reversion (Connors) on index ETFs
def rsi2(lo=10,maxhold=10):
    def f(s,j,c):
        x=c['ser'][s]['c']; m200=sma(x,200,j); m5=sma(x,5,j); r=rsi(x,2,j)
        if m200 is None: return None
        if s in c['pos']:
            ent=c['pos'][s][2]
            return 'sell' if (x[j]>m5 or j-ent>=maxhold) else None
        if x[j]>m200 and r<lo: return ('buy',-r)
        return None
    return f
rec('RSI2 pullback SPY/QQQ/IWM',run(['SPY','QQQ','IWM'],rsi2(),slots=3,cost=ETF_COST))
rec('RSI2 pullback 11 sector+index ETFs',run(['SPY','QQQ','IWM','XLK','XLE','XLV','XLF','XLI','XLY','XLP','XLU'],rsi2(),slots=3,cost=ETF_COST))
# S3 dual momentum rotation, monthly, top 3 of a diversified ETF list, only if beating SHY
UNI=['SPY','QQQ','IWM','EFA','EEM','TLT','IEF','GLD','DBC','VNQ']
def rot(look=126,top=3,univ=UNI,safe='SHY'):
    last={'m':None}
    def f(d,c):
        m=d[:7]
        if m==last['m']: return None
        last['m']=m
        ser,idx=c['ser'],c['idx']
        def ret(s):
            j=idx[s][d]; x=ser[s]['c']; return x[j]/x[j-look]-1 if j>=look else None
        r=[(ret(s),s) for s in univ]; r=[t for t in r if t[0] is not None]
        if not r: return None
        sr=ret(safe) or 0
        return [s for v,s in sorted(r,reverse=True)[:top] if v>sr]
    return f
rec('Dual momentum ETF rotation (6m, top3, monthly)',run(UNI+['SHY'],None,slots=3,cost=ETF_COST,rebalance=rot()))
rec('Dual momentum ETF rotation (3m, top3, monthly)',run(UNI+['SHY'],None,slots=3,cost=ETF_COST,rebalance=rot(63)))
SEC=['XLK','XLE','XLV','XLF','XLI','XLY','XLP','XLU','GLD','TLT']
rec('Sector momentum rotation (6m, top3, monthly)',run(SEC+['SHY'],None,slots=3,cost=ETF_COST,rebalance=rot(126,3,SEC)))
# CRYPTO (365-day years)
rec('BTC buy & hold',run(['BTC-USD'],lambda s,j,c:('buy',0) if s not in c['pos'] else None,slots=1,cost=C_TAKER,ppy=365))
for n in (20,50,100):
    rec(f'BTC {n}d trend (taker fees)',run(['BTC-USD'],trend(n),slots=1,cost=C_TAKER,ppy=365))
    rec(f'BTC {n}d trend (maker fees)',run(['BTC-USD'],trend(n),slots=1,cost=C_MAKER,ppy=365))
rec('BTC+ETH 50d trend (taker)',run(['BTC-USD','ETH-USD'],trend(50),slots=2,cost=C_TAKER,ppy=365))
# crypto weekly rotation: top 2 by 28d return among majors, only if BTC above 50d
CR=['BTC-USD','ETH-USD','LTC-USD','BCH-USD','LINK-USD']
def crot(look=28,top=2):
    last={'w':None}
    import datetime as dt
    def f(d,c):
        w=dt.date.fromisoformat(d).isocalendar()[:2]
        if w==last['w']: return None
        last['w']=w
        ser,idx=c['ser'],c['idx']; j=idx['BTC-USD'][d]; b=ser['BTC-USD']['c']
        if sma(b,50,j) is None or b[j]<sma(b,50,j): return []
        r=[]
        for s in CR:
            k=idx[s][d]; x=ser[s]['c']
            if k>=look: r.append((x[k]/x[k-look]-1,s))
        return [s for v,s in sorted(r,reverse=True)[:top] if v>0]
    return f
rec('Crypto weekly rotation top2 + BTC filter (taker)',run(CR,None,slots=2,cost=C_TAKER,ppy=365,rebalance=crot()))
# short-term crypto momentum like the current bot: buy after +2..8% day, exit next day
def daymo(s,j,c):
    x=c['ser'][s]['c']
    if s in c['pos']: return 'sell'
    if j>0 and 0.02<=x[j]/x[j-1]-1<=0.08: return ('buy',0)
rec('Current-style: buy after +2-8% day, hold 1 day (taker)',run(CR,daymo,slots=3,cost=C_TAKER,ppy=365))
json.dump(R,open('results.json','w'),indent=1)
