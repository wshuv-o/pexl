"""Minimal FinAi caller; run with six positional arguments (see docs)."""
import json
import os
from pathlib import Path
import sys

import httpx


def main():
    if len(sys.argv) != 7:
        raise SystemExit('Usage: finai_client.py source.xlsx template.xlsx source_sheet template_sheet mapping.json output.xlsx')
    source_path, template_path, source_sheet, template_sheet, mapping_path, output_path = sys.argv[1:]
    with httpx.Client(base_url=os.environ.get('PEXL_API_URL', 'http://127.0.0.1:8000'),
                      headers={'Authorization': 'Bearer ' + os.environ['PEXL_API_KEY']},
                      timeout=120) as client:
        ids = []
        for kind, path in [('source', source_path), ('template', template_path)]:
            with open(path, 'rb') as file:
                response = client.post('/api/v1/files/' + kind, files={'file': (Path(path).name, file)})
            response.raise_for_status()
            ids.append(response.json()['id'])
        response = client.post('/api/v1/jobs', json={
            'source_id': ids[0], 'outputs': [{
                'template_id': ids[1], 'source_sheet': source_sheet,
                'template_sheet': template_sheet,
                'mapping': json.loads(Path(mapping_path).read_text(encoding='utf-8')),
            }],
        })
        response.raise_for_status()
        job = response.json()
        output = client.get(job['outputs'][0]['download_path'])
        output.raise_for_status()
        Path(output_path).write_bytes(output.content)
        print(json.dumps({'job_id': job['id'], 'output': output_path}))


if __name__ == '__main__':
    main()
