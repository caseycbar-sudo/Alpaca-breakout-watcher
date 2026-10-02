import json,sys
from bt import run,sma,rsi
R=[]
def rec(name,r): r['name']=name; R.append(r); print(json.dumps(r))
ETF_COST=0.0003   # ~half-spread+slippage on liquid ETFs, Robinhood has no commission
C_TAKER=0.0095+0.0002; C_MAKER=0.005+0.0002

UNI=['SPY','QQQ','IWM','EFA','EEM','TLT','IEF','GLD','DBC','VNQ']
SEC=['XLK','XLE','XLV','XLF','XLI','XLY','XLP','XLU','GLD','TLT']
CR=['BTC-USD','ETH-USD','LTC-USD','BCH-USD','LINK-USD']
def trend(n):
    def f(s,j,c):
        x=c['ser'][s]['c']; m=sma(x,n,j)
        if m is None: return None
        return ('buy',0) if x[j]>m else 'sell'
    return f
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