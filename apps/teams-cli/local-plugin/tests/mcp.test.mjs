import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio MCP exposes bounded read tools and safely handles missing sessions', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foss-teams-test-'));
  fs.writeFileSync(path.join(temp, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'test', name: 'Test', loginHint: 'reader@example.com', tenantId: '11111111-1111-1111-1111-111111111111', tenantName: 'Test tenant' }] }), { mode: 0o600 });
  const root = fileURLToPath(new URL('../', import.meta.url));
  const client = new Client({ name: 'foss-teams-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: '/bin/sh', args: ['scripts/start.sh'], cwd: root, env: { ...process.env, FOSS_TEAMS_DATA_DIR: temp }, stderr: 'pipe' }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['list_accounts', 'list_chats', 'login_status', 'read_messages', 'start_login']);
    assert.equal(tools.find(t => t.name === 'read_messages').annotations.readOnlyHint, true);
    const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
    assert.equal(accounts.structuredContent.accounts[0].auth.authenticated, false);
    const read = await client.callTool({ name: 'list_chats', arguments: { account: 'test' } });
    assert.equal(read.isError, true);
    assert.equal(read.structuredContent.error, 'login_required');
    const invalid = await client.callTool({ name: 'read_messages', arguments: { account: 'test', conversation_id: 'example', limit: 101 } });
    assert.equal(invalid.isError, true);
    const unknown = await client.callTool({ name: 'login_status', arguments: { account: 'unknown' } });
    assert.equal(unknown.structuredContent.error, 'unknown_account');
  } finally { await client.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
