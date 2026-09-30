// Explicit live read smoke check. Does not print messages or credentials.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const client = new Client({ name: 'foss-teams-live-check', version: '1.0.0' });
const output = [];
try {
  await client.connect(new StdioClientTransport({ command: '/bin/sh', args: ['scripts/start.sh'], cwd: root, stderr: 'pipe' }));
  for (const [account, query] of [['lifeline', 'Colosl Weekly Review'], ['sane', 'Forums Go Live']]) {
    const invoke = async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      if (response.isError) throw new Error(JSON.stringify(response.structuredContent));
      return response.structuredContent;
    };
    const status = await invoke('login_status', { account });
    if (status.auth.method !== 'device-code' || !status.auth.authenticated || status.login.phase !== 'complete') throw new Error(`${account}: default-browser login not complete`);
    const chats = await invoke('list_chats', { account, query, limit: 3 });
    if (!chats.chats.length) throw new Error(`${account}: expected chat not found`);
    const messages = await invoke('read_messages', { account, conversation_id: chats.chats[0].id, limit: 3 });
    if (!messages.count) throw new Error(`${account}: no messages returned`);
    output.push({ account, tenant: chats.tenant, authMethod: status.auth.method, totalChats: chats.totalChats, chat: chats.chats[0].title, messagesRead: messages.count, containsMessageText: messages.messages.some(m => m.text.length > 0) });
  }
  console.log(JSON.stringify({ passed: true, checks: output }, null, 2));
} finally { await client.close(); }
