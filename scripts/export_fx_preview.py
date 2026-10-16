#!/usr/bin/env python3
"""Create an offline, private HTML viewer from an FX model snapshot."""
import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def export_preview(snapshot_path, output_path):
    snapshot_path, output_path = Path(snapshot_path).resolve(), Path(output_path).resolve()
    if any(p.is_relative_to(REPO) for p in (snapshot_path, output_path)):
        raise ValueError('Private snapshots and previews must stay outside the public repository.')
    payload = json.loads(snapshot_path.read_text(encoding='utf-8'))
    if payload.get('schemaVersion') != 1 or payload.get('pair') != 'USDKRW':
        raise ValueError('Expected a version 1 USDKRW snapshot.')
    data = json.dumps(payload, ensure_ascii=False, allow_nan=False).replace('<', '\\u003c')
    css = (REPO / 'dist/styles.css').read_text(encoding='utf-8')
    js = (REPO / 'dist/fx-model-ui.mjs').read_text(encoding='utf-8')
    js = js.replace('export function ', 'function ')
    js = js.replace("if(typeof document!=='undefined')mountFxModel(document);", '')
    html = '''<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>USDKRW · 3 Regime Markov</title>
<style>''' + css + '''
body{margin:0}main.fx-private-preview{max-width:1480px;margin:0 auto;padding:28px 32px}
@media(max-width:600px){main.fx-private-preview{padding:20px 12px}}
</style></head><body><main class="fx-private-preview"><div id="fxModelHost"></div></main>
<script type="application/json" id="fxPrivateSnapshot">''' + data + '''</script>
<script>''' + js + '''
const viewer=mountFxModel(document);
viewer.install(JSON.parse(document.getElementById('fxPrivateSnapshot').textContent));
</script></body></html>'''
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html, encoding='utf-8')
    print(output_path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    export_preview(args.input, args.output)
