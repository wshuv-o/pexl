"""MCP bridge tests, including a real stdio protocol handshake."""
import asyncio
import base64
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

import mcp_server
import test_integration


class MCPTests(unittest.TestCase):
    setUp = test_integration.IntegrationTests.setUp
    tearDown = test_integration.IntegrationTests.tearDown
    upload = test_integration.IntegrationTests.upload
    job = test_integration.IntegrationTests.job
    def test_tools_execute_against_api(self):
        async def run():
            def call(method, path, **kwargs):
                result = self.client.request(method, path, **kwargs)
                result.raise_for_status()
                return result

            with patch.object(mcp_server, 'request', side_effect=call):
                source = mcp_server.upload_workbook('source', 'source.xlsx',
                    base64.b64encode(test_integration.excel([['Name', 'Amount'], ['Alice', 10]])).decode())
                template = self.upload('template', [['Customer', 'Balance']])
                content = await mcp_server.mcp.call_tool('fill_templates', {
                    'job': self.job(source['id'], template),
                })
                self.assertTrue(content)
                self.assertEqual(mcp_server.inspect_workbook('source', source['id'], 'Sheet')['headers'],
                                 ['Name', 'Amount'])
        asyncio.run(run())

    def test_stdio_handshake(self):
        async def run():
            params = StdioServerParameters(command=sys.executable,
                args=[str(Path(__file__).with_name('mcp_server.py').resolve())], env=dict(os.environ))
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.list_tools()
                    self.assertEqual({t.name for t in result.tools}, {
                        'upload_workbook', 'inspect_workbook', 'fill_templates',
                        'get_job', 'download_output',
                    })
        asyncio.run(asyncio.wait_for(run(), timeout=20))


if __name__ == '__main__':
    unittest.main()
