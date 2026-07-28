// 极简 mock MCP 服务器（stdio JSON-RPC，换行分隔）——仅用于 U5 客户端端到端冒烟
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } });
    } else if (msg.method === 'notifications/initialized') {
      // 无需响应
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'create_page', description: '创建页面', inputSchema: { type: 'object', properties: { db: { type: 'string' }, title: { type: 'string' } } } },
        { name: 'query', description: '查询', inputSchema: { type: 'object' } },
      ] } });
    } else if (msg.method === 'tools/call') {
      const { name, arguments: a } = msg.params || {};
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `called ${name} with ${JSON.stringify(a)}` }], isError: false } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
    }
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
