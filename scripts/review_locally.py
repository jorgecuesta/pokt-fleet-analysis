"""Run on your own computer to review the already-built saved-data website.

No data collection, dependencies, account access or publication is performed.
Python 3.10+ is sufficient. Ctrl+C closes the local review server.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import hashlib
import json
import re
import threading
import webbrowser


def reviewed_directory(root):
    dist = root / 'dist'
    index = dist / 'index.html'
    if not index.is_file():
        raise ValueError('Built website missing. Run npm run build from the project folder first.')
    html = index.read_text(encoding='utf-8')
    match = re.search(r'const SAVED_SETTLEMENT_ASSET=([^;]+);', html)
    if not match or not json.loads(match.group(1)):
        raise ValueError('This folder does not contain the current monthly settlement build.')
    asset = json.loads(match.group(1))
    if not re.fullmatch(r'settlements-[0-9a-f]{16}\.bin', asset['filename']):
        raise ValueError('Unexpected saved asset name.')
    binary = dist / asset['filename']
    if not binary.is_file() or hashlib.sha256(binary.read_bytes()).hexdigest() != asset['sha256']:
        raise ValueError('The saved monthly data file is missing or changed. Extract the whole package again.')
    return dist


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--no-open', action='store_true', help='Print the local URL without opening your browser.')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    root = Path(__file__).resolve().parents[1]
    try:
        dist = reviewed_directory(root)
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as exc:
        parser.exit(1, f'Cannot open the review: {exc}\n')
    server = None
    for port in range(args.port, min(args.port + 10, 65536)):
        try:
            server = ThreadingHTTPServer(('127.0.0.1', port), partial(SimpleHTTPRequestHandler, directory=str(dist)))
            break
        except OSError:
            continue
    if server is None:
        parser.exit(1, 'No free local port. Try --port 8080.\n')
    url = f'http://127.0.0.1:{server.server_port}/'
    print(f'Local review: {url}', flush=True)
    print('Keep this window open. Ctrl+C stops the server.', flush=True)
    print('No Pocket API requests or publication. Follow docs/review-guide.md.', flush=True)
    if not args.no_open:
        timer = threading.Timer(0.3, lambda: webbrowser.open(url))
        timer.daemon = True
        timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nLocal review stopped.')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
