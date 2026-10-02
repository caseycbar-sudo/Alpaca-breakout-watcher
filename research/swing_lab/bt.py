import json,math,statistics as st
def load(s):
    r=json.load(open(f'data/{s}.json'))
    # use adjusted series: scale OHLC by adj/close
    out={}
    for d,o,h,l,c,a in r:
        if None in (o,h,l,c,a) or c==0: continue
        k=a/c; out[d]=(o*k,h*k,l*k,a)
    return out
def sma(x,n,i): return sum(x[i-n+1:i+1])/n if i>=n-1 else None
def rsi(x,n,i):
    if i<n: return None
    g=l=0
    for j in range(i-n+1,i+1):
        d=x[j]-x[j-1]; g+=max(d,0); l+=max(-d,0)
    return 100 if l==0 else 100-100/(1+g/l)
def stats(eq,dates,trades,label,ppy=252):
    rets=[eq[i]/eq[i-1]-1 for i in range(1,len(eq))]
    yrs=len(eq)/ppy; cagr=(eq[-1]/eq[0])**(1/yrs)-1
    pk=eq[0];mdd=0
    for v in eq: pk=max(pk,v); mdd=min(mdd,v/pk-1)
    sh=st.mean(rets)/st.pstdev(rets)*math.sqrt(ppy) if st.pstdev(rets)>0 else 0
    # sub-periods
    def sub(a,b):
        idx=[i for i,d in enumerate(dates) if a<=d<b]
        if len(idx)<20: return None
        return (eq[idx[-1]]/eq[idx[0]])**(ppy/len(idx))-1
    w=[t for t in trades if t>0]
    pf=sum(w)/-sum(t for t in trades if t<0) if any(t<0 for t in trades) else float('inf')
    return dict(name=label,start=dates[0],cagr=round(cagr*100,1),maxdd=round(mdd*100,1),sharpe=round(sh,2),
        trades_per_yr=round(len(trades)/yrs,1),win=round(100*len(w)/max(1,len(trades)),0),pf=round(pf,2),
        first_half=round((sub(dates[0],dates[len(dates)//2]) or 0)*100,1),second_half=round((sub(dates[len(dates)//2],'9999') or 0)*100,1),
        last3y=round((sub('2023-10-01','9999') or 0)*100,1),last1y=round((sub('2025-10-01','9999') or 0)*100,1))
def run(universe,signal,slots=3,cost=0.0002,start=None,ppy=252,rebalance=None):
    """signal(sym,i,ctx)->'buy'|'sell'|None evaluated at close i; fills at open i+1.
    rebalance: optional fn(i,ctx)->list of target syms (overrides signal)."""
    D={s:load(s) for s in universe}
    dates=sorted(set.intersection(*[set(v) for v in D.values()])) if rebalance else sorted(set().union(*[set(v) for v in D.values()]))
    if start: dates=[d for d in dates if d>=start]
    ser={s:{'d':[],'c':[],'o':[],'h':[],'l':[]} for s in universe}
    idx={}
    for s in universe:
        ks=sorted(D[s]); 
        for j,d in enumerate(ks):
            o,h,l,c=D[s][d]; ser[s]['d'].append(d);ser[s]['o'].append(o);ser[s]['h'].append(h);ser[s]['l'].append(l);ser[s]['c'].append(c)
        idx[s]={d:j for j,d in enumerate(ks)}
    cash=1.0; pos={}  # sym->(units,entry_cost,entry_i)
    eq=[];trades=[];pending=[]
    for t,d in enumerate(dates):
        # execute pending at today's open
        for act,s in pending:
            if d not in idx[s]: continue
            j=idx[s][d]; px=ser[s]['o'][j]
            if act=='sell' and s in pos:
                u,basis,_=pos.pop(s); v=u*px*(1-cost); cash+=v; trades.append(v/basis-1)
            elif act=='buy' and s not in pos and len(pos)<slots:
                val=cash+sum(u*ser[x]['c'][idx[x][max(k for k in idx[x] if k<=d)]] if d not in idx[x] else u*ser[x]['o'][idx[x][d]] for x,(u,_,_) in pos.items())
                amt=min(cash,val/slots)
                if amt<=1e-9: continue
                u=amt*(1-cost)/px; pos[s]=(u,amt,j); cash-=amt
        pending=[]
        # mark
        val=cash
        for s,(u,_,_) in pos.items():
            j=idx[s].get(d); 
            if j is None: j=max(idx[s][k] for k in idx[s] if k<=d)
            val+=u*ser[s]['c'][j]
        eq.append(val)
        ctx=dict(ser=ser,idx=idx,pos=pos,d=d)
        if rebalance:
            tgt=rebalance(d,ctx)
            if tgt is not None:
                for s in list(pos):
                    if s not in tgt: pending.append(('sell',s))
                for s in tgt:
                    if s not in pos: pending.append(('buy',s))
                # sells first
                pending.sort(key=lambda a:a[0]!='sell')
        else:
            sells=[];buys=[]
            for s in universe:
                j=idx[s].get(d)
                if j is None: continue
                a=signal(s,j,ctx)
                if a=='sell' and s in pos: sells.append(('sell',s))
                if a and a[0]=='buy' and s not in pos: buys.append((a[1] if isinstance(a,tuple) else 0,s))
            buys.sort(reverse=True)
            free=slots-len(pos)+len(sells)
            pending=sells+[('buy',s) for _,s in buys[:max(0,free)]]
    return stats(eq,dates,trades,'',ppy)
