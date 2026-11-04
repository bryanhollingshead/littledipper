/**
 * The MCP server: AI assistants (Muse, Claude, ChatGPT, a model the owner runs) work with the owner's data
 * through tools. Each tool is a call to this node's own REST API with the assistant's key, so the API stays the
 * only front door (Commandment XI): the key's scopes, the audit log and record provenance all apply unchanged.
 *
 * Transport: MCP Streamable HTTP, stateless. POST /api/mcp takes one JSON-RPC message and answers with JSON.
 * Auth: an app key as a Bearer token. The browser session cookie is never accepted here.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bearer, findKey } from '../auth.js';
import { VERSION } from '../config.js';
import { MAX_FILE_BYTES } from '../files.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BATCH = 50;

const INSTRUCTIONS = `This is the owner's Little Dipper: their records (addresses, jobs, IDs, insurance, vehicles and more, each with when it applied), their documents, and the dates that matter.
- Call whoami first to see which kinds of records your key can read or change.
- Call list_kinds to learn each kind's fields before adding or updating records. Use the field keys it gives you.
- Dated kinds keep history: when something ends (a move, a job change), set validTo on the old record and add a new one, rather than overwriting it.
- Fields marked secret come back masked. You can't read their values.
- There is no delete tool. If something was filed wrong, tell the owner: they can undo or remove it.`;

type Json = Record<string, unknown>;
type Call = (method: string, url: string, body?: unknown, contentType?: string) => Promise<{ status: number; body: unknown }>;
type Tool = { name: string; title: string; description: string; inputSchema: Json; annotations?: Json; run: (args: Json, call: Call) => Promise<unknown> };

const str = (description: string) => ({ type: 'string', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const recordFields = {
  data: { type: 'object', description: 'Field values keyed by field key (from list_kinds). In an update, a field set to null is removed; fields not mentioned stay as they are.' },
  validFrom: str('When it started applying, YYYY-MM-DD (or YYYY-MM, YYYY). Dated kinds only.'),
  validTo: str('When it stopped applying. Leave out while it still applies.'),
  notes: str('Free-text notes.'),
};

/** The REST answer, or a ToolError the assistant can read and explain. */
class ToolError extends Error {}
async function ok(p: ReturnType<Call>) {
  const r = await p;
  if (r.status >= 400) {
    const b = (r.body || {}) as { code?: string; message?: string };
    throw new ToolError(`${b.code || 'error'}: ${b.message || `HTTP ${r.status}`}`);
  }
  return r.body as Json;
}

const q = (params: Record<string, unknown>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
  return s ? `?${s}` : '';
};
const kindOf = (args: Json) => encodeURIComponent(String(args.kind || ''));
const recordInput = (args: Json) => ({ data: args.data, validFrom: args.validFrom, validTo: args.validTo, notes: args.notes });
const brief = (r: Json) => ({ id: r.id, kind: r.domain, title: r.title, current: r.current, validFrom: r.validFrom, validTo: r.validTo, data: r.data, masked: r.masked });
const day = (d: Date) => d.toISOString().slice(0, 10);

const TOOLS: Tool[] = [
  {
    name: 'whoami', title: 'What can I do here?',
    description: 'Your connection to this Little Dipper: your name, the scopes your key carries (which kinds of records you can read or change) and when it expires. Call this first.',
    inputSchema: obj({}), annotations: { readOnlyHint: true },
    run: async (_a, call) => ok(call('GET', '/api/keys/me')),
  },
  {
    name: 'list_kinds', title: 'Kinds of records',
    description: 'The kinds of records you can see (residences, employment, ids, vehicles, insurance…), each with its fields: key, label, type, whether it is required, its options and its sensitivity. Also whether the kind is dated (keeps history with validFrom/validTo) and how many records it has.',
    inputSchema: obj({}), annotations: { readOnlyHint: true },
    run: async (_a, call) => {
      const { domains } = await ok(call('GET', '/api/catalog')) as { domains: Json[] };
      return {
        kinds: domains.map((d) => ({
          kind: d.id, label: d.label, description: d.description, dated: d.dated, count: d.count, currentCount: d.currentCount,
          fields: (d.parts as Json[]).filter((p) => !p.deprecated).map((p) => ({
            key: p.key, label: p.label, type: p.type, required: !!p.required, sensitivity: p.sensitivity,
            ...(p.options ? { options: (p.options as [string, string][]).map(([k, l]) => ({ value: k, label: l })) } : {}),
            ...(p.of ? { rowFields: (p.of as Json[]).map((x) => ({ key: x.key, label: x.label, type: x.type })) } : {}),
          })),
        })),
      };
    },
  },
  {
    name: 'list_records', title: 'List records',
    description: 'Every record of one kind, newest first. Use current=true for only what applies today, or from/to (YYYY-MM-DD) for what applied in a period, e.g. every address in the last five years.',
    inputSchema: obj({ kind: str('The kind, from list_kinds (e.g. residences).'), current: { type: 'boolean' }, from: str('YYYY-MM-DD'), to: str('YYYY-MM-DD') }, ['kind']),
    annotations: { readOnlyHint: true },
    run: async (a, call) => {
      const r = await ok(call('GET', `/api/data/${kindOf(a)}${q({ current: a.current ? 'true' : undefined, from: a.from, to: a.to })}`)) as { items: Json[] };
      return { kind: a.kind, records: r.items.map(brief) };
    },
  },
  {
    name: 'search_records', title: 'Search records',
    description: 'Find records by words in their title, fields or notes, across every kind you can see (or one kind).',
    inputSchema: obj({ query: str('Words to look for, e.g. "passport" or "Honda".'), kind: str('Limit to one kind.') }, ['query']),
    annotations: { readOnlyHint: true },
    run: async (a, call) => {
      const needle = String(a.query || '').trim().toLowerCase();
      const kinds = a.kind ? [String(a.kind)] : ((await ok(call('GET', '/api/catalog'))) as { domains: Json[] }).domains.map((d) => String(d.id));
      const found: Json[] = [];
      for (const k of kinds) {
        const r = await call('GET', `/api/data/${encodeURIComponent(k)}`);
        if (r.status >= 400) continue;
        for (const rec of (r.body as { items: Json[] }).items) {
          if (JSON.stringify([rec.title, rec.data, rec.notes]).toLowerCase().includes(needle)) found.push(brief(rec));
        }
      }
      return { query: a.query, records: found.slice(0, 100) };
    },
  },
  {
    name: 'get_record', title: 'Read a record',
    description: 'One record in full, with the documents filed on it.',
    inputSchema: obj({ kind: str('The kind.'), id: str('The record id.') }, ['kind', 'id']),
    annotations: { readOnlyHint: true },
    run: async (a, call) => {
      const r = await ok(call('GET', `/api/data/${kindOf(a)}/${encodeURIComponent(String(a.id))}`));
      return { ...brief(r), notes: r.notes, documents: r.documents, updatedBy: r.updatedByLabel, updatedAt: r.updatedAt };
    },
  },
  {
    name: 'add_record', title: 'Add a record',
    description: 'Add one record of a kind. Check list_kinds for its fields first.',
    inputSchema: obj({ kind: str('The kind.'), ...recordFields }, ['kind', 'data']),
    run: async (a, call) => brief(await ok(call('POST', `/api/data/${kindOf(a)}`, recordInput(a)))),
  },
  {
    name: 'add_records', title: 'Add several records',
    description: `Add up to ${MAX_BATCH} records of one kind in one call, e.g. imported from another account. Each is added on its own: the result says which were added and which failed, and why.`,
    inputSchema: obj({ kind: str('The kind.'), records: { type: 'array', maxItems: MAX_BATCH, items: obj(recordFields, ['data']) } }, ['kind', 'records']),
    run: async (a, call) => {
      const list = Array.isArray(a.records) ? (a.records as Json[]) : [];
      if (list.length > MAX_BATCH) throw new ToolError(`too_many: at most ${MAX_BATCH} records per call`);
      const results = [];
      for (const [i, rec] of list.entries()) {
        const r = await call('POST', `/api/data/${kindOf(a)}`, recordInput(rec));
        const b = (r.body || {}) as Json;
        results.push(r.status < 400 ? { index: i, added: true, id: b.id, title: b.title } : { index: i, added: false, error: `${b.code}: ${b.message}` });
      }
      return { kind: a.kind, added: results.filter((r) => r.added).length, failed: results.filter((r) => !r.added).length, results };
    },
  },
  {
    name: 'update_record', title: 'Update a record',
    description: 'Change some fields of a record. Only the fields you send change; set a field to null to remove it. To record that something ended, set validTo instead of changing it into something else.',
    inputSchema: obj({ kind: str('The kind.'), id: str('The record id.'), ...recordFields }, ['kind', 'id']),
    run: async (a, call) => brief(await ok(call('PATCH', `/api/data/${kindOf(a)}/${encodeURIComponent(String(a.id))}`, recordInput(a)))),
  },
  {
    name: 'search_documents', title: 'Find documents',
    description: 'Documents (scans, photos, PDFs) you can see, newest first. Filter by words in the title, notes or read text, by document kind, or by the record they are filed on.',
    inputSchema: obj({ query: str('Words to look for.'), documentKind: str('e.g. receipt, insurance card, lease.'), kind: str('Only documents filed on records of this kind.'), recordId: str('Only documents filed on this record (with kind).') }),
    annotations: { readOnlyHint: true },
    run: async (a, call) => {
      const r = await ok(call('GET', `/api/documents${q({ q: a.query, kind: a.documentKind, domain: a.kind, recordId: a.recordId })}`)) as { items: Json[] };
      return {
        documents: r.items.slice(0, 50).map((d) => ({
          id: d.id, title: d.title, kind: d.kind, date: d.date, status: d.status, pages: (d.pages as unknown[]).length,
          filedOn: (d.links as Json[]).map((l) => ({ kind: l.domain, id: l.recordId, title: l.title })), hasText: !!d.text,
        })),
      };
    },
  },
  {
    name: 'get_document', title: 'Read a document',
    description: 'One document: its details, the records it is filed on, and the text read from its pages (if any has been read).',
    inputSchema: obj({ id: str('The document id.') }, ['id']),
    annotations: { readOnlyHint: true },
    run: async (a, call) => {
      const d = await ok(call('GET', `/api/documents/${encodeURIComponent(String(a.id))}`));
      return { id: d.id, title: d.title, kind: d.kind, date: d.date, status: d.status, notes: d.notes, text: d.text, pages: d.pages, filedOn: d.links };
    },
  },
  {
    name: 'upload_document', title: 'Upload a document',
    description: 'Save a photo (JPEG, PNG, WebP, HEIC) or PDF as a new document, optionally filed on a record (e.g. a receipt photo on its receipt, a policy on its insurance record).',
    inputSchema: obj({
      name: str('File name, e.g. receipt.jpg'), mimeType: str('image/jpeg, image/png, image/webp, image/heic or application/pdf'),
      contentBase64: str('The file, base64-encoded.'), title: str('A title for the document.'), documentKind: str('e.g. receipt, insurance card.'),
      date: str('The date on the document, YYYY-MM-DD.'), fileOnKind: str('File it on a record of this kind…'), fileOnId: str('…with this id.'),
    }, ['name', 'mimeType', 'contentBase64']),
    run: async (a, call) => {
      const bytes = Buffer.from(String(a.contentBase64 || ''), 'base64');
      if (!bytes.length) throw new ToolError('empty_file: contentBase64 is empty');
      if (bytes.length > MAX_FILE_BYTES) throw new ToolError(`file_too_large: files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      const link = a.fileOnKind && a.fileOnId ? `${a.fileOnKind}:${a.fileOnId}` : undefined;
      const d = await ok(call('POST', `/api/documents${q({ name: a.name, title: a.title, kind: a.documentKind, date: a.date, link })}`, bytes, String(a.mimeType)));
      return { id: d.id, title: d.title, kind: d.kind, filedOn: d.links };
    },
  },
  {
    name: 'upcoming_dates', title: 'Upcoming dates',
    description: 'What is coming up: events plus the dates already in the records (renewals, passport and license expiry, warranty ends, birthdays).',
    inputSchema: obj({ days: { type: 'integer', minimum: 1, maximum: 400, description: 'How far ahead to look. Default 90.' } }),
    annotations: { readOnlyHint: true },
    run: async (a, call) => {
      const from = new Date(), to = new Date(Date.now() + Math.min(400, Math.max(1, Number(a.days) || 90)) * 86400_000);
      return ok(call('GET', `/api/calendar${q({ from: day(from), to: day(to) })}`));
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
const toolList = TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, ...(annotations ? { annotations } : {}) }));

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };
const rpcError = (id: RpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(msg: RpcMessage, call: Call) {
  const id = msg.id;
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion || '');
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'little-dipper', title: 'Little Dipper', version: VERSION },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: toolList } };
    case 'tools/call': {
      const tool = byName.get(String(msg.params?.name));
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${msg.params?.name}`);
      try {
        const out = await tool.run((msg.params?.arguments as Json) || {}, call);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false } };
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }], isError: true } };
      }
    }
    default: return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export default async function mcpRoutes(app: FastifyInstance) {
  app.post('/api/mcp', { bodyLimit: Math.ceil(MAX_FILE_BYTES * 1.4) + 64 * 1024 }, async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    if (!(await findKey(token, ['app']))) {
      return reply.code(401).header('www-authenticate', 'Bearer').send({ code: 'unauthenticated', message: 'Connect with an app key from Little Dipper (Apps and access).' });
    }
    // Every tool runs as a request to this node's own API, carrying the assistant's key and nothing else.
    const call: Call = async (method, url, body, contentType) => {
      const r = await app.inject({
        method: method as 'GET', url,
        headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': req.ip, ...(body !== undefined ? { 'content-type': contentType || 'application/json' } : {}) },
        payload: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
      let parsed: unknown = null;
      try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = r.body; }
      return { status: r.statusCode, body: parsed };
    };

    const body = req.body as RpcMessage | RpcMessage[] | undefined;
    if (!body || typeof body !== 'object') return reply.code(400).send(rpcError(null, -32700, 'Parse error'));
    const msgs = Array.isArray(body) ? body : [body];
    const out = [];
    for (const m of msgs) {
      // Notifications (no id) and responses get no reply.
      if (m.id === undefined || !m.method) continue;
      out.push(await handle(m, call));
    }
    if (!out.length) return reply.code(202).send();
    return reply.type('application/json').send(Array.isArray(body) ? out : out[0]);
  });

  // Stateless server: no server-to-client stream and no sessions to end.
  app.get('/api/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ code: 'method_not_allowed', message: 'POST JSON-RPC messages to this endpoint.' }));
  app.delete('/api/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ code: 'method_not_allowed', message: 'This MCP server keeps no sessions.' }));
}
