import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { addr, ApiError, copy, get, initials, patch, post, type NodeInfo, type Owner } from '../../api';
import { Loading, useToast } from '../../ui';

type Admin = {
  owner: Owner;
  node: NodeInfo;
  tech: boolean;
  setTech: (v: boolean) => void;
  pendingIn: number;
  unreadMessages: number;
  refresh: () => void;
};
const AdminCtx = createContext<Admin>(null as never);
export const useAdmin = () => useContext(AdminCtx);

const NAV: [string, string][] = [['/admin', 'Home'], ['/admin/life', 'My life'], ['/admin/receipts', 'Receipts'], ['/admin/contacts', 'Contacts'], ['/admin/messages', 'Messages'], ['/admin/public', 'Public profile'], ['/admin/apps', 'Apps and access'], ['/admin/settings', 'Settings']];
const DOCS: [string, string][] = [['/admin/reference/model', 'Data model'], ['/admin/reference/endpoints', 'Endpoints']];

const Badge = ({ n }: { n: number }) => (
  <span style={{ minWidth: 20, height: 20, borderRadius: 999, background: 'var(--color-accent)', color: 'var(--color-bg)', fontSize: 11, display: 'grid', placeItems: 'center', padding: '0 6px' }}>{n}</span>
);

export default function AdminLayout() {
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const [owner, setOwner] = useState<Owner | null>(null);
  const [node, setNode] = useState<NodeInfo | null>(null);
  const [pendingIn, setPendingIn] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [authError, setAuthError] = useState(false);
  const [n, setN] = useState(0);

  const load = useCallback(async () => {
    try {
      const [o, nd, reqs, unread] = await Promise.all([get<Owner>('/api/v1/owner'), get<NodeInfo>('/api/v1/node'), get('/api/v1/federation/requests?status=pending&direction=in'), get<{ count: number }>('/api/v1/messages/unread')]);
      setOwner(o);
      setNode(nd);
      // Stranger requests under "Anyone" wait quietly: no badge.
      setPendingIn(reqs.items.filter((r: { quiet: boolean }) => !r.quiet).length);
      setUnreadMessages(unread.count);
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
    <AdminCtx.Provider value={{ owner, node, tech, setTech, pendingIn, unreadMessages, refresh: () => setN((x) => x + 1) }}>
      <div className="shell">
        <aside className="sidebar" aria-label="Main">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px 4px', flex: 'none' }}>
            <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--color-accent)', color: 'var(--color-bg)', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 600, flex: 'none' }}>{initials(owner.displayName)}</span>
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 18, lineHeight: 1.15 }}>{owner.displayName}</span>
          </div>
          <div className="text-muted mono brand-addr" style={{ padding: '2px 10px 0 50px', fontSize: 11, overflowWrap: 'anywhere' }}>{addr(node.address)}</div>
          <div className="text-muted mono brand-addr" style={{ padding: '2px 10px 18px 50px' }}>
            <button type="button" title={`${node.id} · click to copy`} onClick={async () => toast((await copy(node.id)) ? 'Node ID copied' : node.id)}
              style={{ all: 'unset', cursor: 'pointer', fontSize: 11, opacity: 0.75 }}>{node.id.slice(0, 8)}…{node.id.slice(-4)}</button>
          </div>
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/admin'} className="nav-pill" aria-current={isOn(to) ? 'page' : undefined}>
              {label}
              {to === '/admin/contacts' && pendingIn > 0 && <Badge n={pendingIn} />}
              {to === '/admin/messages' && unreadMessages > 0 && <Badge n={unreadMessages} />}
            </NavLink>
          ))}
          {tech && (
            <>
              <div className="text-muted side-label" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', padding: '18px 14px 4px' }}>Build reference</div>
              {DOCS.map(([to, label]) => <NavLink key={to} to={to} className="nav-pill" aria-current={isOn(to) ? 'page' : undefined}>{label}</NavLink>)}
            </>
          )}
          <div className="side-foot" style={{ marginTop: 'auto', padding: '16px 10px 0', display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 13, fontWeight: 600 }}>Signed in</div><div className="text-muted" style={{ fontSize: 11 }}>{tech ? `Owner · ${owner.role}` : 'Owner'}</div></div>
            <button className="btn btn-ghost" onClick={signOut} style={{ fontSize: 12 }}>Sign out</button>
          </div>
        </aside>
        <main className="main">
          <Outlet />
        </main>
      </div>
    </AdminCtx.Provider>
  );
}
