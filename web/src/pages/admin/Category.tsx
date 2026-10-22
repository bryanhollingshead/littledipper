import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post, SENS } from '../../api';
import { ErrorNote, Loading, useAction, useAsync } from '../../ui';
import { Details, duration, fetchCatalog, fmtRange, groupOf, Lock, Mono, RecordEditor, useContactsLite, type ContactLite, type Domain, type Rec } from '../../life';
import { plural } from './LifeHub';

const FEEDS: Record<string, string> = { address: 'Current address', city: 'Current city', country_res: 'Country of residence', email: 'Email', phone: 'Mobile phone' };

/** A sentence that explains why a category is worth filling in. */
const WHY: Record<string, string> = {
  residences: 'Rental applications, background checks and government forms ask for 5–10 years of addresses.',
  employment: 'Job applications, loans and clearance forms all want your work history with dates and supervisors.',
  ids: 'Keep every number and expiry date in one place. You’ll get a heads-up before anything expires.',
  education: 'Degrees and dates for applications and your résumé.',
  health: 'Allergies, medications and directives, ready for a new doctor or an emergency.',
  insurance: 'Policy and member numbers when you need to file a claim.',
  relationships: 'The people closest to you, and who to call in an emergency.',
  contact_methods: 'Every way to reach you. Your primary email and phone show in your profile.',
  preferences: 'Sizes, tastes and habits: what lets an assistant actually help.',
  travel: 'Visa and clearance applications ask where you’ve been and when.',
};

export default function Category() {
  const { domain = '' } = useParams();
  const contacts = useContactsLite();
  const { data: catalog, reload: reloadCatalog } = useAsync(fetchCatalog, []);
  const { data, error, reload } = useAsync(() => get<{ items: Rec[] }>(`/api/v1/${domain}`), [domain]);
  const [editing, setEditing] = useState<Rec | 'new' | null>(null);

  const d = catalog?.find((x) => x.id === domain);
  if (error) return <div><Link className="btn btn-ghost" to="/admin/life">← My data</Link><ErrorNote error={error} /></div>;
  if (!d || !data) return <Loading />;
  const g = groupOf(d.group);
  const current = d.dated ? data.items.filter((r) => r.current) : data.items;
  const past = d.dated ? data.items.filter((r) => !r.current) : [];
  const done = () => { setEditing(null); reload(); reloadCatalog(); };

  return (
    <div data-screen-label={d.label} style={{ maxWidth: 980 }}>
      <Link className="btn btn-ghost" to="/admin/life" style={{ marginBottom: 14 }}>← My data</Link>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <Mono d={d} size={64} />
        <div style={{ flex: 1, minWidth: 260 }}>
          <div className="card-kicker" style={{ color: g.ink }}>{g.label}</div>
          <h1 style={{ margin: 0 }}>{d.label}</h1>
          <p className="text-muted" style={{ margin: '4px 0 0', maxWidth: 620 }}>{d.description}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>Add {/^[aeiou]/i.test(d.noun) ? 'an' : 'a'} {d.noun}</button>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '18px 0 6px' }}>
        <span className={`tag ${SENS[d.sensitivity][1]}`} style={{ gap: 4 }}>{d.sensitivity === 'secret' && <Lock style={{ width: 8, height: 9 }} />}{SENS[d.sensitivity][0]}</span>
        <span className="tag tag-neutral">{d.sharedWith ? `Shared with ${d.sharedWith} contact${d.sharedWith === 1 ? '' : 's'}` : 'Not shared with anyone'}</span>
        {d.feeds.length > 0 && <span className="tag tag-neutral">Feeds {d.feeds.map((f) => FEEDS[f] ?? f).join(' · ')}</span>}
      </div>

      {data.items.length === 0 ? (
        <div className="card" style={{ marginTop: 22, padding: '34px 30px', gap: 10, alignItems: 'flex-start', background: g.wash, position: 'relative', overflow: 'hidden' }}>
          <div aria-hidden style={{ position: 'absolute', right: -60, top: -60, width: 200, height: 200, borderRadius: '50%', background: 'var(--color-neutral-100)', opacity: 0.5 }} />
          <div className="card-title" style={{ fontSize: 22, position: 'relative' }}>No {plural(d.noun)} yet</div>
          <div style={{ fontSize: 14, maxWidth: 520, position: 'relative' }}>{WHY[d.id] ?? d.description}</div>
          <button className="btn btn-primary" style={{ marginTop: 6, position: 'relative' }} onClick={() => setEditing('new')}>Add your first {d.noun}</button>
        </div>
      ) : (
        <>
          {current.length > 0 && (
            <div style={{ marginTop: 22 }}>
              {d.dated && <h4>Current</h4>}
              <div style={{ display: 'grid', gap: 14 }}>
                {current.map((r) => <RecordCard key={r.id} d={d} r={r} contacts={contacts} onEdit={() => setEditing(r)} />)}
              </div>
            </div>
          )}
          {past.length > 0 && (
            <div style={{ marginTop: 30 }}>
              <h4>History</h4>
              <div style={{ position: 'relative', paddingLeft: 26 }}>
                <div aria-hidden style={{ position: 'absolute', left: 7, top: 10, bottom: 10, width: 2, background: 'var(--color-neutral-300)', borderRadius: 2 }} />
                <div style={{ display: 'grid', gap: 14 }}>
                  {past.map((r) => (
                    <div key={r.id} style={{ position: 'relative' }}>
                      <span aria-hidden style={{ position: 'absolute', left: -25, top: 24, width: 14, height: 14, borderRadius: '50%', background: 'var(--color-bg)', border: `3px solid ${g.ink}` }} />
                      <RecordCard d={d} r={r} contacts={contacts} onEdit={() => setEditing(r)} quiet />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {editing && <RecordEditor d={d} rec={editing === 'new' ? null : editing} contacts={contacts} onClose={() => setEditing(null)} onSaved={done} />}
    </div>
  );
}

function RecordCard({ d, r, contacts, onEdit, quiet }: { d: Domain; r: Rec; contacts: ContactLite[]; onEdit: () => void; quiet?: boolean }) {
  const { run } = useAction();
  const [revealed, setRevealed] = useState<Record<string, unknown> | null>(null);
  const reveal = async () => {
    if (revealed) return setRevealed(null);
    const x = await run(() => post<Rec>(`/api/v1/${d.id}/${r.id}/reveal`));
    if (x) setRevealed(x.data);
  };
  const range = fmtRange(r.validFrom, r.validTo);
  return (
    <div className="card" style={{ padding: '20px 24px', gap: 0, background: quiet ? 'var(--color-neutral-100)' : 'var(--color-surface)' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: quiet ? 17 : 20, lineHeight: 1.2 }}>{revealed ? r.title.replace(/•+/g, '…') : r.title}</div>
          {range && <div className="text-muted" style={{ fontSize: 13, marginTop: 2 }}>{range}{r.validFrom ? ` · ${duration(r.validFrom, r.validTo)}` : ''}</div>}
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {r.masked.length > 0 && <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={reveal}>{revealed ? 'Hide' : 'Reveal'}</button>}
          <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={onEdit}>Edit</button>
        </div>
      </div>
      <Details d={d} rec={r} revealed={revealed ?? undefined} contacts={contacts} />
      {r.notes && <p className="text-muted" style={{ fontSize: 13, margin: '12px 0 0', whiteSpace: 'pre-wrap' }}>{r.notes}</p>}
    </div>
  );
}
