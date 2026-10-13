#!/usr/bin/env python3
"""Reuse the user's attached V5 archive's immutable pinned REST evidence.

Does not run or extract code from the ZIP, import floating heads, or relabel the
original retrieval date as today. URL, height and body must match the new cache
key exactly. Fresh indexer payouts still use the new collection cutoff.
"""
import argparse
import gzip
import hashlib
import json
import zipfile
from collections import Counter
from pathlib import Path
from pokt_live_collector import API, CACHE_NAMESPACE, atomic_json, digest


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('archive',type=Path)
    p.add_argument('--out',type=Path,required=True)
    args=p.parse_args()
    count=Counter()
    archive_hash=hashlib.sha256(args.archive.read_bytes()).hexdigest()
    with zipfile.ZipFile(args.archive) as z:
        members=[m for m in z.infolist() if '/cache/http/' in m.filename and m.filename.endswith('.json.gz')]
        for i,member in enumerate(members):
            compressed=z.read(member)
            d=json.loads(gzip.decompress(compressed))
            h=d.get('requested_height')
            if h is None or d.get('served_height')!=str(h) or not d['url'].startswith(API+'/pokt-network/poktroll/') or d.get('body') is not None:
                continue
            key=digest([CACHE_NAMESPACE,d['url'],None,h,None])
            path=args.out/'responses'/key[:2]/(key+'.json.gz')
            if path.exists():
                continue
            d.update(response_sha256=digest(d['response']),received_bytes=d.get('received_bytes'),
                     provenance={'kind':'attached_original_v5','archive_sha256':archive_hash,
                                 'member':member.filename,'member_sha256':hashlib.sha256(compressed).hexdigest()})
            atomic_json(path,d)
            count[d['url'].split('?')[0].rsplit('/',1)[-1]]+=1
            if sum(count.values())%100==0:
                print('Imported',sum(count.values()),flush=True)
    manifest={'archive_sha256':archive_hash,'counts':dict(count),'rule':'Exact immutable historical REST requests only; original retrieval dates retained.'}
    atomic_json(args.out/'v5_import.json',manifest)
    print(json.dumps(manifest))


if __name__=='__main__':
    main()
