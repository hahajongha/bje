#!/usr/bin/env python3
"""Export a self-contained, private BJE viewer with a data_info snapshot."""
import argparse
import base64
import json
from pathlib import Path
import re

REPO = Path(__file__).resolve().parents[1]


def export_preview(snapshot_path, output_path):
    snapshot_path, output_path = Path(snapshot_path).resolve(), Path(output_path).resolve()
    if any(p.is_relative_to(REPO) for p in (snapshot_path, output_path)):
        raise ValueError('Private snapshots and previews must stay outside the public repository.')
    payload = json.loads(snapshot_path.read_text(encoding='utf-8'))
    if payload.get('schemaVersion') != 1 or payload.get('kind') != 'bje_data_info':
        raise ValueError('Expected a version 1 BJE data_info snapshot.')
    dist = REPO / 'dist'
    imports = {}
    for path in sorted(dist.glob('*.mjs')):
        source = path.read_text(encoding='utf-8')
        source = re.sub(r"from (['\"])\./([\w-]+)\.mjs\1", r"from 'bje:\2'", source)
        if path.name == 'app.mjs':
            old = "fetch('./data.json',{cache:'no-store'})"
            if source.count(old) != 1:
                raise ValueError('Portfolio bootstrap changed; inspect exporter before proceeding.')
            source = source.replace(old, "Promise.resolve({ok:true,json:async()=>JSON.parse(document.getElementById('portfolioEmbedded').textContent)})")
        imports['bje:' + path.stem] = 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()
    html = (dist / 'index.html').read_text(encoding='utf-8')
    def inline_style(match):
        path = dist / match.group(1)
        if path.parent != dist or not path.is_file():
            raise ValueError('Invalid local stylesheet reference.')
        return '<style>' + path.read_text(encoding='utf-8') + '</style>'
    html = re.sub(r'<link rel="stylesheet" href="([\w-]+\.css)">', inline_style, html)
    html = re.sub(r'<script type="module" src="[^"]+"></script>', '', html)
    safe_json = lambda value: json.dumps(value, ensure_ascii=False, allow_nan=False).replace('<', '\\u003c')
    script = '\n<script type="application/json" id="dataInfoEmbedded">' + safe_json(payload) + '</script>'
    script += '\n<script type="application/json" id="portfolioEmbedded">' + safe_json(json.loads((dist / 'data.json').read_text(encoding='utf-8'))) + '</script>'
    script += '\n<script type="importmap">' + safe_json({'imports': imports}) + '</script>'
    initial_tab = 'hedge' if payload.get('hedgeFx') else 'risk'
    script += '\n<script type="module">import "bje:app"; document.querySelector(\'[data-tab="' + initial_tab + '"]\').click();</script>\n'
    html = html.replace('</body>', script + '</body>')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html, encoding='utf-8')
    print(output_path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    export_preview(args.input, args.output)
