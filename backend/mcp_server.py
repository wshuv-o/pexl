"""Local stdio MCP bridge to the authenticated Pexl HTTP API."""
import base64
import binascii
import os

import httpx
from mcp.server.fastmcp import FastMCP

from integration_api import JobRequest, MAX_BYTES

mcp = FastMCP('Pexl')


def request(method: str, path: str, **kwargs):
    key = os.environ.get('PEXL_API_KEY')
    if not key:
        raise ValueError('Set PEXL_API_KEY before starting the MCP bridge')
    url = os.environ.get('PEXL_API_URL', 'http://127.0.0.1:8000').rstrip('/')
    with httpx.Client(base_url=url, headers={'Authorization': f'Bearer {key}'},
                      timeout=120, follow_redirects=False) as client:
        response = client.request(method, path, **kwargs)
        response.raise_for_status()
        return response


def identifier(value: str) -> str:
    if len(value) != 32 or any(c not in '0123456789abcdef' for c in value):
        raise ValueError('Expected a Pexl artifact ID')
    return value


@mcp.tool()
def upload_workbook(kind: str, filename: str, content_base64: str) -> dict:
    """Upload a source or template .xlsx. Prefer HTTP multipart for large files."""
    if kind not in ('source', 'template'):
        raise ValueError('kind must be source or template')
    if len(content_base64) > 4 * ((MAX_BYTES + 2) // 3):
        raise ValueError('Workbook exceeds 20 MiB')
    try:
        content = base64.b64decode(content_base64, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError('Invalid base64 workbook')
    return request('POST', f'/api/v1/files/{kind}',
                   files={'file': (filename, content)}).json()


@mcp.tool()
def inspect_workbook(kind: str, file_id: str, sheet: str, header_row: int = 1) -> dict:
    """Inspect uploaded workbook headers before choosing column mappings."""
    if kind not in ('source', 'template'):
        raise ValueError('kind must be source or template')
    return request('GET', f'/api/v1/files/{kind}/{identifier(file_id)}',
                   params={'sheet': sheet, 'header_row': header_row}).json()


@mcp.tool()
def fill_templates(job: JobRequest) -> dict:
    """Fill one or more templates; mapping keys are destination column headers.

    Returns completed job metadata and authenticated HTTP download paths.
    """
    return request('POST', '/api/v1/jobs', json=job.model_dump()).json()


@mcp.tool()
def get_job(job_id: str) -> dict:
    """Retrieve a saved job and its output download paths."""
    return request('GET', f'/api/v1/jobs/{identifier(job_id)}').json()


@mcp.tool()
def download_output(output_id: str) -> dict:
    """Return an output workbook as base64. Use HTTP download paths for large files."""
    response = request('GET', f'/api/v1/outputs/{identifier(output_id)}')
    return {'output_id': output_id, 'content_base64': base64.b64encode(response.content).decode(),
            'media_type': response.headers['content-type']}


if __name__ == '__main__':
    mcp.run(transport='stdio')
