"""Staged notebook orchestration around the unchanged published collector.

7d: the proved Ethereum week plus a bounded paired indexer/on-chain check.
14d: eight services over the final fortnight, after the seven-day checks.
30d: the original fixed monthly plan, after the fourteen-day reconciliation.
All earnings here are conditional on indexed settled sessions. A negative
three-session probe never becomes a verified zero for a whole Application.
"""
from __future__ import annotations

import base64
import binascii
import contextlib
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
import urllib.parse
from datetime import timedelta
from pathlib import Path

import settlement_collect as original
from pokt_live_collector import Client, PAYOUT_REASONS, RPC
from pokt_live_collector import atomic_json, digest, dt, iso, read_json, suffix_rules, utcnow

VERSION = 'staged-settlement-1.0'
SOURCE_COMMIT = 'fc0eb630771b96e157caa38cd687f867dc152dd2'
EXPECTED_COLLECTOR_SHA = '83a42d8abc678dc8893c112f3f4dde37cf260f2e691196ef5e22c940700ccd70'
MODES = ('offline', 'investigate', '7d', '14d', '30d')
RELAY_REASONS = {'TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION', PAYOUT_REASONS[0]}
GLOBAL_REASONS = {'TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION', PAYOUT_REASONS[1]}
UNKNOWN_REASONS = {'', 'UNSPECIFIED', 'UNRECOGNIZED'}


def plan(mode):
    if mode == '7d':
        return original.plan('pilot')
    if mode == '30d':
        return original.plan('month')
    if mode == '14d':
        return {**original.plan('month'), 'stage': 'scale14', 'start': '2026-09-22T00:00:00Z'}
    raise ValueError('Choose 7d, 14d or 30d')


def run_dir(root, mode):
    return Path(root)/'runs'/digest(plan(mode))[:16]


def verify_receipt(path, mode):
    path = Path(path)
    if mode == '7d':
        return original.verify_pilot_report(path)
    proof = read_json(path)
    if proof.get('status') != 'reconciled' or proof.get('config') != plan(mode) or not proof.get('overlap', {}).get('passed'):
        raise ValueError(f'A matching successfully reconciled {mode} receipt is required')
    name = proof.get('artifact')
    if not isinstance(name, str) or not name or Path(name).name != name:
        raise ValueError('Evidence must be a local file beside its receipt')
    artifact = path.parent/name
    if not artifact.is_file() or hashlib.sha256(artifact.read_bytes()).hexdigest() != proof.get('artifactSha256'):
        raise ValueError('Keep the matching receipt and evidence together; evidence checksum differs or is missing')
    evidence = read_json(artifact)
    coverage = evidence.get('coverage', {})
    if evidence.get('codec') != 'settlement-session-v1' or evidence.get('config') != plan(mode) or coverage != proof.get('coverage'):
        raise ValueError('Evidence scope or coverage differs from its receipt')
    if coverage.get('unknownDistributionClaims') != 0 or coverage.get('indexedClaims', 0) <= 0:
        raise ValueError('Resolve unknown distributions before advancing')
    return proof


def choose_pairs(reference, pair_count=3):
    if type(pair_count) is not int or not 1 <= pair_count <= 3:
        raise ValueError('Use one to three session pairs')
    groups = [g for g in reference['monthlyGroups'] if g['serviceId'] == 'eth']
    covered = max(groups, key=lambda g: g['monthlyClaimCount'])
    missing = next(g for g in sorted(groups, key=lambda g: g['applicationId']) if g['monthlyClaimCount'] == 0)
    config = plan('7d')
    rows = [s for s in reference['sessions'] if s['serviceId'] == 'eth'
            and dt(config['start']) <= dt(s['observedAt']) < dt(config['endExclusive'])]
    known = {s['sessionEndHeight']: s for s in rows if s['applicationId'] == covered['applicationId']
             and s['payoutStatus'] == 'complete' and s['settledClaimCount'] > 0}
    unknown = {s['sessionEndHeight']: s for s in rows if s['applicationId'] == missing['applicationId']
               and s['payoutStatus'] == 'missing' and s['settledClaimCount'] == 0}
    ends = sorted(known.keys() & unknown.keys())
    if len(ends) < pair_count:
        raise ValueError('Insufficient matching historical sessions for the paired investigation')
    positions = [0] if pair_count == 1 else [0, len(ends)-1] if pair_count == 2 else [0, len(ends)//2, len(ends)-1]
    return {'covered': covered, 'uncovered': missing,
            'pairs': [{'covered': known[ends[i]], 'uncovered': unknown[ends[i]]} for i in positions]}


def coin_upokt(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+upokt', value):
        raise ValueError('Expected an exact nonnegative integer upokt coin')
    return int(value[:-5])


def decode_attribute(key, value):
    if not isinstance(key, str) or not isinstance(value, str):
        raise ValueError('Malformed ABCI attribute')
    if not re.fullmatch(r'[a-z_][a-z0-9_]*', key):
        try:
            decoded = base64.b64decode(key, validate=True).decode('utf-8')
            if not re.fullmatch(r'[a-z_][a-z0-9_]*', decoded):
                raise ValueError('Invalid decoded attribute name')
            key = decoded
            value = base64.b64decode(value, validate=True).decode('utf-8')
        except (ValueError, UnicodeError, binascii.Error) as exc:
            raise ValueError('Unsupported ABCI attribute encoding') from exc
    try:
        value = json.loads(value)
    except json.JSONDecodeError:
        pass
    return key, value


def chain_event(event, block_height):
    attrs = {}
    for attribute in event.get('attributes', []):
        key, value = decode_attribute(attribute['key'], attribute['value'])
        if key in attrs:
            raise ValueError('Duplicate settlement-event attribute')
        attrs[key] = value
    identity = ('session_id', 'service_id', 'application_address', 'supplier_operator_address')
    if any(not isinstance(attrs.get(k), str) or not attrs[k] for k in identity):
        raise ValueError('A settlement event lacks an identity field')
    end = original.nat(attrs['session_end_block_height'], 'on-chain session end')
    if end >= block_height:
        raise ValueError('Settlement event precedes the session end')
    detailed = attrs.get('reward_distribution_detailed')
    if not isinstance(detailed, list):
        raise ValueError('Detailed on-chain distribution reasons are unavailable')
    payout = 0
    verified = True
    for transfer in detailed:
        reason = transfer.get('op_reason')
        amount = coin_upokt(transfer.get('amount'))
        if not isinstance(transfer.get('recipient_address'), str) or not transfer['recipient_address']:
            raise ValueError('On-chain distribution recipient is missing')
        if reason in UNKNOWN_REASONS or not isinstance(reason, str):
            verified = False
        if reason in RELAY_REASONS | GLOBAL_REASONS:
            payout += amount
    return {'sessionId': attrs['session_id'], 'serviceId': attrs['service_id'],
            'applicationId': attrs['application_address'], 'supplierId': attrs['supplier_operator_address'],
            'sessionEndHeight': end, 'blockId': block_height, 'payoutUpokt': str(payout),
            'payoutVerified': verified}


def parse_block_results(response, height):
    if response.get('error'):
        raise ValueError('RPC block_results error: '+str(response['error'])[:600])
    result = response.get('result')
    if not isinstance(result, dict) or original.nat(result.get('height'), 'RPC response height') != height:
        raise ValueError('RPC returned an unexpected historical block height')
    buckets = ('finalize_block_events', 'begin_block_events', 'end_block_events')
    if not any(k in result for k in buckets):
        raise ValueError('RPC response has no supported block-event envelope')
    events = []
    for key in buckets:
        value = result.get(key) or []
        if not isinstance(value, list):
            raise ValueError('Malformed RPC event bucket')
        events.extend(value)
    for tx in result.get('txs_results') or []:
        if original.nat(tx.get('code'), 'transaction result code') == 0:
            events.extend(tx.get('events') or [])
    settlements, seen = [], set()
    for event in events:
        if event.get('type') != 'pocket.tokenomics.EventClaimSettled':
            continue
        row = chain_event(event, height)
        key = (row['sessionId'], row['supplierId'])
        if key in seen:
            raise ValueError('Duplicate on-chain settlement for one Supplier/session')
        seen.add(key)
        settlements.append(row)
    return settlements


def claim_key(row):
    return (row['sessionId'], row['supplierId'], row['serviceId'], row['applicationId'],
            int(row['sessionEndHeight']), int(row['blockId']))


def reconcile_control(indexed, on_chain):
    chain = {claim_key(r): r for r in on_chain}
    if len(chain) != len(on_chain):
        raise ValueError('Repeated on-chain claim identity')
    missing, amounts = [], []
    for row in indexed:
        actual = chain.get(claim_key(row))
        if actual is None:
            missing.append(row['supplierId'])
        elif not actual['payoutVerified'] or not row['payoutVerified'] or actual['payoutUpokt'] != row['payoutUpokt']:
            amounts.append(row['supplierId'])
    return {'passed': bool(indexed) and not missing and not amounts,
            'indexedClaimsChecked': len(indexed), 'absentOnChain': missing, 'distributionDifferences': amounts}


def session_claims(client, session, config, bounds):
    rows = original.roster_page(client, None, None, session_ids=[session['id']])
    if len(rows) != 1 or rows[0]['application_id'] != session['applicationId'] or rows[0]['service_id'] != 'eth':
        raise ValueError('Diagnostic catalog row is missing or belongs to another session')
    if original.nat(rows[0]['end_height'], 'session end') != session['sessionEndHeight']:
        raise ValueError('Diagnostic claims returned another historical session')
    return original.session_claims(rows[0], config, 'eth')


def group_claims(client, config, bounds, application, cutoff):
    """Settled claims of one Application's eth sessions ending in the window, as of a cutoff."""
    start = iso(dt(bounds['start']['timestamp'])-timedelta(hours=1))
    end = iso(dt(bounds['end']['timestamp'])+timedelta(hours=2))
    total, before = 0, None
    for _ in range(1000):
        rows = original.roster_page(client, start, end, ['eth'], before=before, applications=[application])
        total += sum(len(original.session_claims(r, {'cutoff': cutoff}, 'eth')) for r in rows
                     if r['application_id'] == application and bounds['start']['height'] <= original.nat(r['end_height'], 'end') < bounds['end']['height'])
        if len(rows) < original.PAGE_SIZE:
            return total
        before = (original.nat(rows[-1]['start_height'], 'start'), rows[-1]['session_id'])
    raise ValueError('Diagnostic group count exceeded its page budget')


def diagnose_missingness(groups, checks, extra_events, errors):
    source_changes = [g['kind'] for g in groups if g['kind'] == 'uncovered' and g['originalCutoffClaims'] > 0]
    failed_controls = any(not c['control']['passed'] for c in checks) or not checks
    discrepancy = bool(extra_events) or bool(source_changes)
    technical = 'passed' if not errors and not failed_controls and not discrepancy else 'needs_review'
    unknown = next((g for g in groups if g['kind'] == 'uncovered'), None)
    if extra_events:
        finding = 'On-chain settlements are absent from the matching indexed session records; investigate the indexer gap.'
    elif source_changes:
        finding = 'The original-cutoff index has changed since the saved reference; reconcile that change before expansion.'
    elif unknown and unknown['laterCutoffClaims'] > unknown['originalCutoffClaims']:
        finding = 'This group has indexed settlements after the original cutoff. The fixed original view still excludes them.'
    else:
        finding = 'No matching uncovered-group settlement was found in the checked blocks. The cause across the full group remains unresolved.'
    return {'technicalStatus': technical, 'safeToCollectIndexedSettlements': technical == 'passed',
            'missingPaymentFinding': finding,
            'positiveCauseEvidenceFound': bool(extra_events) or bool(source_changes) or bool(unknown and unknown['laterCutoffClaims'] > unknown['originalCutoffClaims']),
            'wholeGroupCauseEstablished': False,
            'scope': 'paired historical Ethereum sessions; all group counts are restricted to the same seven-day window',
            'scopeNotice': 'A bounded negative probe is not proof of no work, no actual income or no settlements across an entire group. Never convert the original unknown sampled outcomes into zero.'}


def investigate(root, reference_path, pair_count=3, progress=print, client=None):
    root = Path(root)
    reference = original.load_reference(reference_path)
    selected = choose_pairs(reference, pair_count)
    config = plan('7d')
    target = root/'investigation'
    target.mkdir(parents=True, exist_ok=True)
    client = client or Client(root, workers=2)
    started = time.perf_counter()
    report = {'version': VERSION, 'sourceCommit': SOURCE_COMMIT, 'referenceProductSha256': original.PRODUCT_SHA256,
              'config': config, 'selectedGroups': {k: selected[k] for k in ('covered', 'uncovered')},
              'pairCount': pair_count, 'groups': [], 'checks': [], 'unindexedOnChainEvents': [], 'errors': [],
              'startedAt': iso(utcnow()), 'laterCutoffIsSeparate': True, 'originalSampledCoverageUnchanged': True}
    try:
        metadata = client.gql('{_metadata{chain lastProcessedHeight}}', fresh=True)['_metadata']
        status = client.request(RPC+'/status', label='rpc-status', fresh=True)
        if status.get('error') or status.get('result', {}).get('node_info', {}).get('network') != 'pocket':
            raise ValueError('RPC is unavailable or not Pocket mainnet')
        if metadata['chain'] != 'pocket':
            raise ValueError('Indexer is not Pocket mainnet')
        head = original.nat(status['result']['sync_info']['latest_block_height'], 'RPC head')
        later = min(original.nat(metadata['lastProcessedHeight'], 'indexer height'), head)
        if later < original.CUTOFF:
            raise ValueError('Sources are behind the fixed historical cutoff')
        report.update(indexerMetadata=metadata, laterCutoff=later)
        bounds = original.resolve_boundaries(client, config)
        report['boundaryBlocks'] = bounds
        for kind in ('covered', 'uncovered'):
            group = selected[kind]
            counts = []
            for cutoff in (original.CUTOFF, later):
                counts.append(group_claims(client, config, bounds, group['applicationId'], cutoff))
            report['groups'].append({'kind': kind, 'serviceId': 'eth', 'applicationId': group['applicationId'],
                                     'originalCutoffClaims': counts[0], 'laterCutoffClaims': counts[1]})
        blocks = {}
        for i, pair in enumerate(selected['pairs'], 1):
            progress(f'Investigation: paired historical session {i}/{pair_count}; checking indexer records and actual block events.')
            control = session_claims(client, pair['covered'], config, bounds)
            unknown = session_claims(client, pair['uncovered'], config, bounds)
            if len(control) != pair['covered']['settledClaimCount']:
                raise ValueError('Covered reference claim count changed under the original cutoff')
            # Keep this probe small. Its negative result never certifies a whole group.
            heights = sorted({int(r['blockId']) for r in control + unknown})
            if not heights or len(set(blocks) | set(heights)) > 12:
                raise ValueError('Investigation lacks a positive control or exceeds twelve RPC blocks')
            for height in heights:
                if height not in blocks:
                    response = client.request(RPC+'/block_results?'+urllib.parse.urlencode({'height': height}), label='block-results')
                    blocks[height] = parse_block_results(response, height)
            events = [e for height in heights for e in blocks[height]]
            control_check = reconcile_control(control, events)
            matching = [e for e in events if e['sessionId'] == pair['uncovered']['id']
                        and e['applicationId'] == pair['uncovered']['applicationId'] and e['serviceId'] == 'eth'
                        and e['sessionEndHeight'] == pair['uncovered']['sessionEndHeight']]
            indexed_keys = {claim_key(r) for r in unknown}
            extra = [e for e in matching if claim_key(e) not in indexed_keys]
            report['unindexedOnChainEvents'].extend(extra)
            report['checks'].append({'observedAt': pair['covered']['observedAt'], 'sessionEndHeight': pair['covered']['sessionEndHeight'],
                                    'coveredSessionId': pair['covered']['id'], 'uncoveredSessionId': pair['uncovered']['id'],
                                    'blockHeightsChecked': heights, 'control': control_check,
                                    'uncoveredIndexedClaims': len(unknown), 'uncoveredOnChainClaimsInCheckedBlocks': len(matching)})
            atomic_json(target/'progress.json', report)
        report['rpcBlocksChecked'] = sorted(blocks)
    except Exception as exc:
        report['errors'].append({'type': type(exc).__name__, 'message': str(exc)[:1600]})
    report.update(diagnose_missingness(report['groups'], report['checks'], report['unindexedOnChainEvents'], report['errors']))
    report.update(completedAt=iso(utcnow()), metrics={'seconds': round(time.perf_counter()-started, 2),
                  'httpAttempts': len(client.metrics), 'wireBytes': sum(m['bytes'] for m in client.metrics)})
    atomic_json(target/'result.json', report)
    progress('Investigation technical status: '+report['technicalStatus'])
    progress(report['missingPaymentFinding'])
    return report


def require_investigation(root, reference_path):
    path = Path(root)/'investigation/result.json'
    if not path.is_file():
        raise ValueError('Run MODE="7d" or MODE="investigate" first; the paired investigation is required')
    report = read_json(path)
    groups = choose_pairs(original.load_reference(reference_path))
    expected = {k: groups[k] for k in ('covered', 'uncovered')}
    if (report.get('version') != VERSION or report.get('config') != plan('7d')
            or report.get('referenceProductSha256') != original.PRODUCT_SHA256 or report.get('selectedGroups') != expected
            or report.get('technicalStatus') != 'passed' or report.get('safeToCollectIndexedSettlements') is not True
            or report.get('errors') or report.get('unindexedOnChainEvents') or not report.get('checks')
            or any(not c.get('control', {}).get('passed') for c in report['checks'])):
        raise ValueError('The investigation needs review. Save its result.json and share the exact error before expansion')
    return report


def collect14(root, reference_path, pilot_report, progress=print, client=None):
    original.verify_pilot_report(pilot_report)
    config = plan('14d')
    reference = original.load_reference(reference_path)
    directory = run_dir(root, '14d')
    directory.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    client = client or Client(root, workers=2)
    db = original.connect(directory/'claims.sqlite3', config)
    state = {'version': VERSION, 'config': config, 'status': 'running', 'startedAt': iso(utcnow()),
             'baseCollectorSha256': hashlib.sha256(Path(original.__file__).read_bytes()).hexdigest(), 'sourceCommit': SOURCE_COMMIT}
    try:
        suffix_rules()
        meta = client.gql('{_metadata{chain lastProcessedHeight}}', fresh=True)['_metadata']
        if meta['chain'] != 'pocket' or original.nat(meta['lastProcessedHeight'], 'indexer height') < config['cutoff']:
            raise ValueError('Wrong chain or indexer behind the fixed cutoff')
        bounds = original.resolve_boundaries(client, config)
        if bounds['start']['height'] < original.ROSTER_ERA_HEIGHT:
            raise ValueError("Window predates the catalog's session rosters")
        state.update(indexerMetadata=meta, boundaryBlocks=bounds,
                     rosterSource={'api': original.GRAPHQL, 'function': 'getSessionRostersJson', 'rostersFromHeight': original.ROSTER_ERA_HEIGHT})
        atomic_json(directory/'run.json', state)
        progress('14d: eight services, all indexed Applications; fixed original cutoff.')
        for service in config['services']:
            original.download_service(client, db, config, service, bounds, progress)
        original.verify_database(db)
        original.fetch_rosters(client, db, config, progress)
        overlap = original.reconcile_reference(db, config, reference)
        evidence = original.compact_evidence(db, config)
        if not overlap['passed'] or evidence['coverage']['unknownDistributionClaims']:
            raise ValueError('Reconciliation needs review before monthly expansion')
        artifact = directory/'settlement-evidence.json.gz'
        atomic_json(artifact, evidence)
        state.update(status='reconciled', completedAt=iso(utcnow()), overlap=overlap, coverage=evidence['coverage'],
                     artifact=artifact.name, artifactSha256=hashlib.sha256(artifact.read_bytes()).hexdigest(),
                     metrics={'seconds': round(time.perf_counter()-started, 2), 'httpAttempts': len(client.metrics),
                              'wireBytes': sum(m['bytes'] for m in client.metrics), 'compressedBytes': artifact.stat().st_size},
                     productUpdate='Not installed. Indexed settled-session scope only; original sampled missingness remains unchanged.')
        atomic_json(directory/'result.json', state)
        atomic_json(directory/'run.json', state)
        return state
    except BaseException as exc:
        state.update(status='failed', errorType=type(exc).__name__, error=str(exc)[:1600], failedAt=iso(utcnow()))
        atomic_json(directory/'run.json', state)
        progress('Stopped. Keep this cache and rerun 14d to resume. '+str(exc)[:600])
        raise
    finally:
        db.close()


@contextlib.contextmanager
def single_collector(root, mode):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    path = root/'.staged-collector.lock'
    try:
        with path.open('x', encoding='utf-8') as file:
            json.dump({'pid': os.getpid(), 'mode': mode, 'startedAt': iso(utcnow())}, file)
    except FileExistsError as exc:
        raise RuntimeError('Another staged run owns this cache. Stop it before restarting. If a kernel crash left this lock, confirm no collector is running before removing '+str(path)) from exc
    try:
        yield
    finally:
        path.unlink(missing_ok=True)


def progress_snapshot(root, mode):
    if mode not in ('7d', '14d', '30d'):
        return {'step': 'paired source investigation'}
    database = run_dir(root, mode)/'claims.sqlite3'
    if not database.is_file():
        return {'step': 'source checks / preparation'}
    connection = sqlite3.connect(database.resolve().as_uri()+'?mode=ro', uri=True, timeout=2)
    try:
        return {'downloadedClaims': connection.execute('SELECT count(*) FROM claims').fetchone()[0],
                'historicalRosters': connection.execute('SELECT count(*) FROM rosters').fetchone()[0],
                'services': [{'service': a, 'expectedClaims': b, 'status': c}
                             for a, b, c in connection.execute('SELECT service,total,status FROM services')]}
    finally:
        connection.close()


@contextlib.contextmanager
def heartbeat(root, mode, progress):
    stopped = threading.Event()
    start = time.monotonic()
    def report():
        while not stopped.wait(30):
            try:
                snapshot = progress_snapshot(root, mode)
            except (sqlite3.Error, OSError):
                snapshot = {'step': 'checkpoint temporarily busy'}
            progress(f'Still running ({int(time.monotonic()-start)}s): '+json.dumps(snapshot, separators=(',', ':')))
    worker = threading.Thread(target=report, daemon=True)
    worker.start()
    try:
        yield
    finally:
        stopped.set()
        worker.join(timeout=3)


def execute(mode, root, reference_path, pilot_report, reuse_pilot=True, progress=print):
    if mode not in MODES or mode == 'offline':
        raise ValueError('execute expects investigate, 7d, 14d or 30d')
    if hashlib.sha256(Path(original.__file__).read_bytes()).hexdigest() != EXPECTED_COLLECTOR_SHA:
        raise ValueError('The pinned published settlement collector differs from this notebook')
    with single_collector(root, mode), heartbeat(root, mode, progress):
        if mode == 'investigate':
            return {'mode': mode, 'investigation': investigate(root, reference_path, progress=progress)}
        if mode == '7d':
            if reuse_pilot:
                receipt = original.verify_pilot_report(pilot_report)
                progress('Reusing the included verified Ethereum pilot; no repeat seven-day download.')
            else:
                receipt = original.run(root, 'pilot', reference_path, progress=progress)
                pilot_report = run_dir(root, '7d')/'result.json'
            diagnosis = investigate(root, reference_path, progress=progress)
            return {'mode': mode, 'receipt': receipt, 'receiptPath': str(Path(pilot_report)), 'investigation': diagnosis}
        require_investigation(root, reference_path)
        original.verify_pilot_report(pilot_report)
        if mode == '14d':
            receipt = collect14(root, reference_path, pilot_report, progress)
        else:
            verify_receipt(run_dir(root, '14d')/'result.json', '14d')
            receipt = original.run(root, 'month', reference_path, pilot_report, progress)
        return {'mode': mode, 'receipt': receipt, 'receiptPath': str(run_dir(root, mode)/'result.json')}


def readiness(receipt, investigation=None):
    cov = receipt.get('coverage', {}) if receipt else {}
    complete = bool(receipt and receipt.get('status') == 'reconciled' and receipt.get('overlap', {}).get('passed'))
    return {'collectionReconciled': complete,
            'indexedClaims': cov.get('indexedClaims'), 'indexedSettledSessions': cov.get('indexedSettledSessions'),
            'unknownReturnedDistributionClaims': cov.get('unknownDistributionClaims'),
            'originalSampledSessions': 4080, 'originalComparableSampledSessions': 1652,
            'originalSampledPayoutCoverage': 1652/4080,
            'missingPaymentInvestigation': investigation.get('technicalStatus') if investigation else 'not run',
            'wholeGroupCauseEstablished': investigation.get('wholeGroupCauseEstablished') if investigation else False,
            'fullNetworkEarningsReady': False, 'historicalPredictionAutomaticallyEnabled': False,
            'notice': 'A complete indexed extraction does not resolve absent-index sessions or guarantee enough fleet-specific evidence for a historical earnings test.'}
