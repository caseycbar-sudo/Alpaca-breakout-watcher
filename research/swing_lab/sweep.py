import json
from bt import run,sma
from strategies_lib import *
def show(n,r): print(f"{n[:50]:50} CAGR {r['cagr']:6} DD {r['maxdd']:6} Sh {r['sharpe']:5} tr/yr {r['trades_per_yr']:5} H1 {r['first_half']:6} H2 {r['second_half']:6} 3y {r['last3y']:6} 1y {r['last1y']}")
print('--- ETF rotation robustness (top N, lookback days)')
for top in (1,2):
  for lk in (42,63,126,189,252):
    show(f'ETF rotation top{top} look{lk}',run(UNI+['SHY'],None,slots=top,cost=ETF_COST,rebalance=rot(lk,top)))
print('--- BTC trend robustness (maker)')
for n in (30,40,50,60,80,100,150,200):
    show(f'BTC {n}d maker',run(['BTC-USD'],trend(n),slots=1,cost=C_MAKER,ppy=365))
print('--- ETH trend (maker)')
for n in (50,100):
    show(f'ETH {n}d maker',run(['ETH-USD'],trend(n),slots=1,cost=C_MAKER,ppy=365))
