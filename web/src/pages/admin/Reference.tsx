import { Navigate } from 'react-router-dom';
import { get, SENS, type Sensitivity } from '../../api';
import { AUTHC, ENDPOINTS, MDARK, SCHEMAS } from '../../reference';
import { useAsync } from '../../ui';
import { useAdmin } from './Layout';

type CatalogDomain = {
  id: string; label: string; group: string; description: string; sensitivity: Sensitivity; dated: boolean; builtIn: boolean; count: number;
  feeds: string[]; scopes: { read: string; write: string }; schemaVersion: number;
  parts: { key: string; label: string; type: string; required?: boolean; sensitivity: Sensitivity; options?: [string, string][] }[];
};
const useCatalog = () => useAsync(() => get<{ domains: CatalogDomain[] }>('/api/v1/catalog'), []).data?.domains;

export function DataModel() {
  const { tech } = useAdmin();
  const domains = useCatalog();
  if (!tech) return <Navigate to="/admin" replace />;
  return (
    <div data-screen-label="Data model" style={{ maxWidth: 1100 }}>
      <h1>Data model</h1>
      <p style={{ maxWidth: 700 }}>Every record is a JSON document in its own collection. Recommended store: MongoDB (Atlas free tier for cloud installs, local <span className="mono">mongod</span> or FerretDB for self-host); small installs can run on the built-in file store. Secret field values are encrypted at the application layer before write, so backups stay safe, and exports are readable once decrypted by the owner.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,440px),1fr))', gap: 18, marginTop: 22, alignItems: 'start' }}>
        {SCHEMAS.map((s) => (
          <div key={s.coll} className="card" style={{ padding: '20px 22px', gap: 8, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}><div className="card-title" style={{ fontSize: 19 }}>{s.name}</div><span className="tag tag-neutral mono">{s.coll}</span></div>
            <div className="card-body">{s.desc}</div>
            <pre className="code">{s.json}</pre>
          </div>
        ))}
      </div>
      <h2 style={{ marginTop: 40 }}>Domains</h2>
      <p style={{ maxWidth: 700 }}>Each domain is a category of personal data with its own endpoint, its own grant in the contact admin and its own app-key scopes. Records live in the <span className="mono">records</span> collection. Parts marked Secret are encrypted one by one, so the rest of a record stays searchable.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,440px),1fr))', gap: 18, marginTop: 18, alignItems: 'start' }}>
        {domains?.map((d) => (
          <div key={d.id} className="card" style={{ padding: '20px 22px', gap: 8, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <div className="card-title" style={{ fontSize: 19 }}>{d.label}</div>
              <span className="tag tag-neutral mono">/api/v1/{d.id}</span>
            </div>
            <div className="card-body">{d.description}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className={`tag ${SENS[d.sensitivity][1]}`}>{SENS[d.sensitivity][0]}</span>
              {d.dated && <span className="tag tag-neutral">Dated</span>}
              {!d.builtIn && <span className="tag tag-outline">Custom</span>}
              {d.feeds.length > 0 && <span className="tag tag-neutral">Feeds {d.feeds.join(', ')}</span>}
              <span className="tag tag-neutral">{d.count} record{d.count === 1 ? '' : 's'}</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ fontSize: 12.5 }}>
                <tbody>
                  {d.parts.map((p) => (
                    <tr key={p.key}>
                      <td className="mono" style={{ whiteSpace: 'nowrap' }}>{p.key}{p.required ? ' *' : ''}</td>
                      <td>{p.label}</td>
                      <td className="mono text-muted" style={{ whiteSpace: 'nowrap' }}>{p.type}{p.options ? `(${p.options.length})` : ''}</td>
                      <td>{p.sensitivity === 'secret' && <span className="tag tag-accent">Secret</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Endpoints() {
  const { tech } = useAdmin();
  const domains = useCatalog();
  if (!tech) return <Navigate to="/admin" replace />;
  const groups = [...new Set(ENDPOINTS.map((e) => e.g))];
  return (
    <div data-screen-label="Endpoints" style={{ maxWidth: 1100 }}>
      <h1>Endpoints</h1>
      <p style={{ maxWidth: 700 }}>REST over HTTPS, JSON bodies, base path <span className="mono">/api/v1</span> for owner calls. The admin UI calls nothing else. Auth types: <strong>owner</strong> (session or API key with scopes), <strong>session</strong> (the owner's signed-in browser only), <strong>peer</strong> (signed requests or a token issued to a connected node), <strong>public</strong> (no auth), <strong>claim</strong> (one-time claim token or setup session).</p>
      <div className="card" style={{ padding: '20px 24px', gap: 8, maxWidth: 820, marginTop: 18 }}>
        <div className="card-kicker">Address rules</div>
        <div style={{ fontSize: 14, display: 'grid', gap: 6 }}>
          <div>1. The base address is configuration, never hard-coded. Every path is identical on any host: <span className="mono">{'{base}'}/api/v1/…</span></div>
          <div>2. The server answers on every bound address (host address, custom domain, IP) and ignores which one a request arrived on. <span className="mono">/.well-known/little-dipper</span> names the canonical one.</div>
          <div>3. Integrations store the permanent ID and public key; the address is only a last-known hint.</div>
          <div>4. On address change the node sends a signed <span className="mono">/peer/v1/address-change</span> to every connection. Tokens stay valid.</div>
          <div>5. Old addresses keep answering with 301 redirects to the canonical address for at least 90 days.</div>
          <div>6. Cloud installs default to the provider hostname (e.g. <span className="mono">*.onrender.com</span>), never a raw IP, since provider IPs aren't stable.</div>
        </div>
      </div>
      {groups.map((g) => (
        <div key={g} style={{ marginTop: 28 }}>
          <h4>{g}</h4>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <tbody>
                {ENDPOINTS.filter((e) => e.g === g).map((e) => (
                  <tr key={e.m + e.p}>
                    <td style={{ width: 70 }}><span className="mono" style={{ fontSize: 11, fontWeight: 700, color: MDARK[e.m] }}>{e.m}</span></td>
                    <td className="mono" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{e.p}</td>
                    <td><span className={`tag ${AUTHC[e.auth]}`}>{e.auth}</span></td>
                    <td style={{ fontSize: 13 }}>{e.d}{e.scope && <span className="text-muted mono" style={{ fontSize: 11 }}> · {e.scope}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 28 }}>
        <h4>Domain endpoints</h4>
        <p className="text-muted" style={{ fontSize: 13, maxWidth: 700 }}>Every domain answers the six Domains routes above at its own path. App keys can be limited to one domain with its scopes.</p>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <tbody>
              {domains?.map((d) => (
                <tr key={d.id}>
                  <td className="mono" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>/api/v1/{d.id}</td>
                  <td style={{ fontSize: 13 }}>{d.label}</td>
                  <td className="mono text-muted" style={{ fontSize: 11 }}>{d.scopes.read} · {d.scopes.write}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
