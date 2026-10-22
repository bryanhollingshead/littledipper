import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { addr, ApiError, copy, get, initials, patch, post, type NodeInfo, type Owner } from '../../api';
import { Loading, useToast } from '../../ui';
import { Icon, type IconName } from '../../icons';

type Admin = {
  owner: Owner;
  node: NodeInfo;
  tech: boolean;
  setTech: (v: boolean) => void;
  pendingIn: number;
  unreadMessages: number;
  inboxDocs: number;
  refresh: () => void;
};
const AdminCtx = createContext<Admin>(null as never);
export const useAdmin = () => useContext(AdminCtx);

const NAV: [string, string, IconName][] = [
  ['/admin', 'Home', 'home'], ['/admin/life', 'My data', 'data'], ['/admin/documents', 'Documents', 'documents'], ['/admin/lifestream', 'Lifestream', 'lifestream'],
  ['/admin/receipts', 'Receipts', 'receipts'], ['/admin/contacts', 'Contacts', 'contacts'], ['/admin/messages', 'Messages', 'messages'],
  ['/admin/public', 'Public profile', 'profile'], ['/admin/apps', 'Apps and access', 'apps'], ['/admin/settings', 'Settings', 'settings'],
];
const DOCS: [string, string, IconName][] = [['/admin/reference/model', 'Data model', 'model'], ['/admin/reference/endpoints', 'Endpoints', 'endpoints']];

const Badge = ({ n }: { n: number }) => <span className="nav-badge">{n}</span>;

/** Whether the sidebar is folded to icons: a per-device convenience, so browser storage. */
const RAIL_KEY = 'ld.sidebar.rail';
function readRail() {
  try { return localStorage.getItem(RAIL_KEY) === '1'; } catch { return false; }
}

export default function AdminLayout() {
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const [owner, setOwner] = useState<Owner | null>(null);
  const [node, setNode] = useState<NodeInfo | null>(null);
  const [pendingIn, setPendingIn] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [inboxDocs, setInboxDocs] = useState(0);
  const [authError, setAuthError] = useState(false);
  const [n, setN] = useState(0);
  const [rail, setRail] = useState(readRail);
  const toggleRail = () => setRail((v) => {
    try { localStorage.setItem(RAIL_KEY, v ? '0' : '1'); } catch { /* fine: just not remembered */ }
    return !v;
  });

  const load = useCallback(async () => {
    try {
      const [o, nd, reqs, unread, docs] = await Promise.all([get<Owner>('/api/v1/owner'), get<NodeInfo>('/api/v1/node'), get('/api/v1/federation/requests?status=pending&direction=in'), get<{ count: number }>('/api/v1/messages/unread'), get<{ items: unknown[] }>('/api/v1/documents?status=inbox')]);
      setOwner(o);
      setNode(nd);
      // Stranger requests under "Anyone" wait quietly: no badge.
      setPendingIn(reqs.items.filter((r: { quiet: boolean }) => !r.quiet).length);
      setUnreadMessages(unread.count);
      setInboxDocs(docs.items.length);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthError(true);
    }
  }, []);

  useEffect(() => { load(); }, [load, n, loc.pathname]);

  if (authError) return <Navigate to="/login" replace />;
  if (!owner || !node) return <div style={{ padding: 48 }}><Loading /></div>;

  const tech = owner.prefs.showTechnical;
  const setTech = async (v: boolean) => {
    setOwner({ ...owner, prefs: { ...owner.prefs, showTechnical: v } });
    await patch('/api/v1/owner', { prefs: { showTechnical: v } });
    if (!v && loc.pathname.startsWith('/admin/reference')) nav('/admin');
  };
  const signOut = async () => {
    await post('/api/v1/auth/logout');
    nav('/login', { replace: true });
  };
  const isOn = (to: string) => (to === '/admin' ? loc.pathname === '/admin' : loc.pathname.startsWith(to));

  return (
    <AdminCtx.Provider value={{ owner, node, tech, setTech, pendingIn, unreadMessages, inboxDocs, refresh: () => setN((x) => x + 1) }}>
      <div className="shell">
        <aside className="sidebar" aria-label="Main" data-rail={rail ? '1' : '0'}>
          <div className="side-head">
            <span className="side-avatar" title={rail ? owner.displayName : undefined}>{initials(owner.displayName)}</span>
            <span className="side-name">{owner.displayName}</span>
            <button type="button" className="bare side-toggle" onClick={toggleRail} aria-expanded={!rail} aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'} title={rail ? 'Expand sidebar' : 'Collapse sidebar'}>
              <Icon name="panel" size={18} />
            </button>
          </div>
          <div className="text-muted mono brand-addr" style={{ padding: '2px 10px 0 50px', fontSize: 11, overflowWrap: 'anywhere' }}>{addr(node.address)}</div>
          <div className="text-muted mono brand-addr" style={{ padding: '2px 10px 14px 50px' }}>
            <button type="button" title={`${node.id} · click to copy`} onClick={async () => toast((await copy(node.id)) ? 'Node ID copied' : node.id)}
              style={{ all: 'unset', cursor: 'pointer', fontSize: 11, opacity: 0.75 }}>{node.id.slice(0, 8)}…{node.id.slice(-4)}</button>
          </div>
          {NAV.map(([to, label, icon]) => {
            const count = to === '/admin/contacts' ? pendingIn : to === '/admin/messages' ? unreadMessages : to === '/admin/documents' ? inboxDocs : 0;
            return (
              <NavLink key={to} to={to} end={to === '/admin'} className="nav-pill" aria-current={isOn(to) ? 'page' : undefined}
                title={rail ? (count ? `${label} (${count})` : label) : undefined} aria-label={rail ? (count ? `${label} (${count})` : label) : undefined}>
                <Icon name={icon} className="nav-ico" />
                <span className="nav-label">{label}</span>
                {count > 0 && <Badge n={count} />}
              </NavLink>
            );
          })}
          {tech && (
            <>
              <div className="text-muted side-label" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', padding: '18px 14px 4px' }}>Build reference</div>
              {rail && <div className="side-rule" aria-hidden />}
              {DOCS.map(([to, label, icon]) => (
                <NavLink key={to} to={to} className="nav-pill" aria-current={isOn(to) ? 'page' : undefined} title={rail ? label : undefined} aria-label={rail ? label : undefined}>
                  <Icon name={icon} className="nav-ico" />
                  <span className="nav-label">{label}</span>
                </NavLink>
              ))}
            </>
          )}
          <div className="side-foot">
            <div className="side-who"><div style={{ fontSize: 13, fontWeight: 600 }}>Signed in</div><div className="text-muted" style={{ fontSize: 11 }}>{tech ? `Owner · ${owner.role}` : 'Owner'}</div></div>
            <button className="btn btn-ghost side-signout" onClick={signOut} title={rail ? 'Sign out' : undefined} aria-label="Sign out">
              <Icon name="signout" size={18} /><span className="nav-label">Sign out</span>
            </button>
          </div>
        </aside>
        <main className="main">
          <Outlet />
        </main>
      </div>
    </AdminCtx.Provider>
  );
}
