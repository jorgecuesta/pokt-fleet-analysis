"""Deliberate data collection; run without --fetch for a local workload preview."""
import argparse
from pathlib import Path
import pandas as pd
from pokt_exposure.core import HistoricalCache, SAMPLING, build_many

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--services',nargs='+',required=True)
    p.add_argument('--start',required=True,help='UTC start date, included')
    p.add_argument('--end',required=True,help='UTC end date, excluded')
    p.add_argument('--mode',choices=list(SAMPLING),default='Standard')
    p.add_argument('--fetch',action='store_true',help='Explicitly permit historical API requests')
    p.add_argument('--refresh-payouts',action='store_true',help='Create new frozen versions using fresh payout queries')
    p.add_argument('--cache',type=Path,default=Path(__file__).parent/'cache')
    args=p.parse_args();cache=HistoricalCache(args.cache)
    days=pd.date_range(args.start,args.end,inclusive='left',tz='UTC')
    times=[(d+pd.Timedelta(hours=h)).isoformat() for d in days for h in SAMPLING[args.mode]]
    points=[cache.read('block',t) for t in times if cache.has('block',t)]
    print(f'{len(days)} days × {len(SAMPLING[args.mode])} times/day × all eligible Applications at each height.')
    print(f'{len(points)}/{len(times)} block lookups cached; services: {", ".join(args.services)}.')
    print(f'Shared registry snapshots cached at {sum(cache.has("registry_height",p["height"]) for p in points)} requested heights.')
    if not args.fetch:
        print('Preview only: 0 HTTP requests. Add --fetch to collect missing inputs.');return
    print(build_many(cache,args.services,args.start,args.end,mode=args.mode,refresh_payouts=args.refresh_payouts))

if __name__=='__main__':main()
