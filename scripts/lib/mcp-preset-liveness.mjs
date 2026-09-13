import ts from 'typescript';

// Read catalog data without loading mcp-store's browser/storage dependencies.
// An unsupported entry must fail the monitor, never silently lose coverage.
export function extractPresets(source) {
  const file = ts.createSourceFile('mcp-store.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(node => ts.isIdentifier(node.name) && node.name.text === 'MCP_PRESETS');
  const array = declaration?.initializer;
  if (file.parseDiagnostics.length || !array || !ts.isArrayLiteralExpression(array) || !array.elements.length) {
    throw new Error('Could not read non-empty MCP_PRESETS catalog');
  }
  return array.elements.map(element => {
    if (!ts.isObjectLiteralExpression(element) || element.properties.some(ts.isSpreadAssignment)) {
      throw new Error('MCP_PRESETS entries must be explicit objects');
    }
    const preset = {};
    for (const key of ['name', 'serverUrl', 'defaultTool', 'authNote']) {
      const property = element.properties.find(node => node.name?.text === key);
      if (!property && key !== 'name' && key !== 'serverUrl') continue;
      if (!property || !ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) {
        throw new Error(`MCP_PRESETS ${key} must be a string literal`);
      }
      preset[key] = property.initializer.text;
    }
    return preset;
  });
}

export function isTemplatePreset(preset) {
  const host = new URL(preset.serverUrl).hostname;
  return ['example.com', 'example.net', 'example.org'].some(domain => host === domain || host.endsWith(`.${domain}`));
}

export async function probePreset(preset, { fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 15_000 } = {}) {
  const result = { name: preset.name, serverUrl: preset.serverUrl, ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(preset.serverUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': 'WorldMonitor-MCP-Proxy/1.0',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'worldmonitor', version: '1.0' } },
      }),
      signal: controller.signal,
    });
    result.observed = `HTTP ${response.status}`;
    result.ok = response.status === 200 || (Boolean(preset.authNote) && [401, 403].includes(response.status));
  } catch (error) {
    result.ok = false;
    result.observed = controller.signal.aborted
      ? `Request timeout after ${timeoutMs}ms`
      : `Request failed: ${error.cause?.code || error.code || error.name}: ${error.message}`;
  } finally {
    clearTimeout(timer);
    // Liveness needs only headers; release SSE connections without changing the verdict.
    controller.abort();
  }
  return result;
}
