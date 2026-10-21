import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../../api';
import { ErrorNote, Loading, Pills, useAsync } from '../../ui';
import { duration, fetchCatalog, fmtRange, GROUPS, groupOf, Mono } from '../../life';

type Item = { domain: string; domainLabel: string; id: string; title: string; validFrom: string; validTo: string | null; current: boolean };

/** Your life, in order: every dated record across every category. */
export default function Timeline() {
  const { data, error } = useAsync(() => get<{ items: Item[] }>('/api/v1/timeline'), []);
  const { data: catalog } = useAsync(fetchCatalog, []);
  const [group, setGroup] = useState('all');
  if (error) return <ErrorNote error={error} />;
  if (!data || !catalog) return <Loading />;

  const dom = (id: string) => catalog.find((d) => d.id === id);
  const items = data.items.filter((i) => group === 'all' || dom(i.domain)?.group === group);
  const byYear = new Map<string, Item[]>();
  for (const i of items) {
    const y = i.validFrom.slice(0, 4);
    byYear.set(y, [...(byYear.get(y) || []), i]);
  }
  const groupsPresent = GROUPS.filter((g) => data.items.some((i) => dom(i.domain)?.group === g.id));

  return (
    <div data-screen-label="Timeline" style={{ maxWidth: 900 }}>
      <Link className="btn btn-ghost" to="/admin/life" style={{ marginBottom: 14 }}>← My life</Link>
      <h1>Your timeline</h1>
      <p className="text-muted" style={{ maxWidth: 620 }}>Every home, job, school and milestone with a date, newest first. Fill in the gaps and applications, background checks and your assistants get the full story.</p>
      {groupsPresent.length > 1 && <Pills value={group} options={[['all', 'Everything'], ...groupsPresent.map((g) => [g.id, g.label] as [string, string])]} onChange={setGroup} style={{ margin: '18px 0 8px' }} />}

      {items.length === 0 ? (
        <div className="card" style={{ marginTop: 22, padding: '30px 28px', gap: 10, alignItems: 'flex-start', background: 'var(--color-accent-2-100)' }}>
          <div className="card-title" style={{ fontSize: 22 }}>Nothing dated yet</div>
          <div style={{ fontSize: 14, maxWidth: 520 }}>Start with where you live and where you work. Each one you add, with a “from” date, appears here.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="btn btn-primary" to="/admin/life/residences">Add a residence</Link>
            <Link className="btn btn-secondary" to="/admin/life/employment">Add a job</Link>
          </div>
        </div>
      ) : (
        <div style={{ position: 'relative', marginTop: 24, paddingLeft: 92 }}>
          <div aria-hidden style={{ position: 'absolute', left: 70, top: 6, bottom: 6, width: 2, background: 'var(--color-neutral-300)', borderRadius: 2 }} />
          {[...byYear.entries()].map(([year, list]) => (
            <div key={year} style={{ position: 'relative', marginBottom: 22 }}>
              <div style={{ position: 'absolute', left: -92, top: 4, width: 58, textAlign: 'right', fontFamily: 'var(--font-heading)', fontSize: 20, color: 'var(--color-neutral-700)' }}>{year}</div>
              <div style={{ display: 'grid', gap: 10 }}>
                {list.map((i) => {
                  const d = dom(i.domain);
                  const g = groupOf(d?.group || 'custom');
                  return (
                    <Link key={i.id} to={`/admin/life/${i.domain}`} style={{ position: 'relative', textDecoration: 'none', color: 'inherit' }}>
                      <span aria-hidden style={{ position: 'absolute', left: -29, top: 18, width: 14, height: 14, borderRadius: '50%', background: i.current ? g.ink : 'var(--color-bg)', border: `3px solid ${g.ink}` }} />
                      <div className="card" style={{ padding: '14px 18px', gap: 2, flexDirection: 'row', alignItems: 'center', background: i.current ? g.wash : 'var(--color-surface)' }}>
                        {d && <Mono d={d} size={34} />}
                        <div style={{ flex: 1, minWidth: 0, marginLeft: 10 }}>
                          <div style={{ fontSize: 15, fontWeight: 600 }}>{i.title}</div>
                          <div className="text-muted" style={{ fontSize: 12 }}>{i.domainLabel} · {fmtRange(i.validFrom, i.validTo)} · {duration(i.validFrom, i.validTo)}</div>
                        </div>
                        {i.current && <span className="tag tag-accent-2">Now</span>}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
