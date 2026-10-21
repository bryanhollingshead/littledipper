/**
 * "What {name} can see": a connected contact's access, laid out as optional attributes.
 * Profile first (basic profile + extra fields), then every life category with Off / Current / All.
 */
import { useState } from 'react';
import { put, SENS, type ContactDetail, type Field } from '../../api';
import { Confirm, Pills, Toggle, useAction, useAsync, type ConfirmCfg } from '../../ui';
import { fetchCatalog, GROUPS, Lock, Mono, type Domain } from '../../life';

type Grants = ContactDetail['grants'];
type DomainGrant = { scope: 'all' | 'current'; includeSecret: boolean };
type Level = 'off' | 'current' | 'all';

const PRESETS: { id: string; label: string; hint: string; domains: Record<string, Level> }[] = [
  { id: 'colleague', label: 'Colleague', hint: 'Current job, education, credentials, contact methods', domains: { employment: 'current', education: 'all', credentials: 'all', contact_methods: 'all' } },
  { id: 'friend', label: 'Friend', hint: 'Contact methods, current home, preferences, pets', domains: { contact_methods: 'all', residences: 'current', preferences: 'all', pets: 'all' } },
  { id: 'family', label: 'Family', hint: 'Homes, family, pets, preferences, life events, insurance', domains: { contact_methods: 'all', residences: 'all', relationships: 'all', pets: 'all', preferences: 'all', life_events: 'all', insurance: 'current' } },
  { id: 'basic', label: 'Just the basics', hint: 'Basic profile only', domains: {} },
];

export default function ContactAccess({ c, fields, first, onGrants }: { c: ContactDetail; fields: Field[]; first: string; onGrants: (g: Grants) => void }) {
  const { run, busy } = useAction();
  const { data: catalog } = useAsync(fetchCatalog, []);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const [extraOpen, setExtraOpen] = useState<boolean | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const grants = c.grants;
  const dg = grants.domains || {};

  const send = async (body: object, msg?: string) => {
    const g = await run(() => put<Grants>(`/api/v1/contacts/${c.id}/grants`, body), msg);
    if (g) onGrants(g);
    return g;
  };

  // ── profile fields ──
  const standard = fields.filter((f) => f.sensitivity === 'standard');
  const extraRows = fields.filter((f) => f.sensitivity !== 'standard' || !grants.profile);
  const extraOn = grants.fields.length;
  const requestedSensitive = c.requested.some((k) => fields.find((f) => f.key === k)?.sensitivity !== 'standard');
  const showExtra = extraOpen ?? (extraOn > 0 || requestedSensitive);
  const toggleField = (f: Field) => {
    const on = grants.fields.includes(f.key);
    if (!on && f.sensitivity === 'secret') {
      return setConfirm({
        title: `Share ${f.label} with ${first}?`,
        body: `This is a secret field. ${first} will see the full value until you turn this off. Each read is logged in your activity.`,
        cta: 'Share it',
        onConfirm: async () => { await send({ fields: { [f.key]: true }, confirm: true }, `${f.label} shared with ${first}`); setConfirm(null); },
      });
    }
    send({ fields: { [f.key]: !on } });
  };

  // ── categories ──
  const levelOf = (d: Domain): Level => (dg[d.id] ? (d.dated ? dg[d.id].scope : 'all') : 'off');
  const hasSecretParts = (d: Domain) => d.parts.some((p) => p.sensitivity === 'secret');
  const setLevel = (d: Domain, level: Level, includeSecret = dg[d.id]?.includeSecret ?? false) => {
    if (level === 'off') return send({ domains: { [d.id]: false } }, `${d.label} hidden from ${first}`);
    const grant: DomainGrant = { scope: level === 'current' ? 'current' : 'all', includeSecret };
    if ((d.sensitivity === 'secret' && !dg[d.id]) || (includeSecret && !dg[d.id]?.includeSecret)) {
      const secretParts = d.parts.filter((p) => p.sensitivity === 'secret').map((p) => p.label.toLowerCase());
      return setConfirm({
        title: `Share ${d.label} with ${first}?`,
        body: includeSecret
          ? `${first} will also see the secret details: ${secretParts.join(', ')}. Each read is logged in your activity.`
          : `${d.label} is a secret category. ${first} will see it${d.dated ? (grant.scope === 'current' ? ' (current entries)' : ' (all entries)') : ''} until you turn this off.${secretParts.length ? ` Secret details (${secretParts.join(', ')}) stay hidden unless you include them.` : ''} Each read is logged.`,
        cta: 'Share it',
        onConfirm: async () => { await send({ domains: { [d.id]: grant }, confirm: true }, `${d.label} shared with ${first}`); setConfirm(null); },
      });
    }
    return send({ domains: { [d.id]: grant } });
  };

  const applyPreset = async (p: (typeof PRESETS)[number]) => {
    if (!catalog) return;
    const domains: Record<string, false | DomainGrant> = {};
    for (const d of catalog) {
      const want = p.domains[d.id];
      // Presets never switch on secret categories; "Just the basics" switches everything off.
      if (d.sensitivity === 'secret' && p.id !== 'basic') continue;
      if (want) domains[d.id] = { scope: d.dated && want === 'current' ? 'current' : 'all', includeSecret: false };
      else if (dg[d.id]) domains[d.id] = false;
    }
    await send({ profile: true, domains }, `${p.label} access applied`);
  };

  const sharedDomains = catalog?.filter((d) => dg[d.id]) ?? [];
  const summary = [grants.profile ? 'Basic profile' : null, extraOn ? `${extraOn} extra field${extraOn === 1 ? '' : 's'}` : null, sharedDomains.length ? `${sharedDomains.length} categor${sharedDomains.length === 1 ? 'y' : 'ies'}` : null].filter(Boolean).join(' + ') || 'Nothing';
  const activePreset = PRESETS.find((p) => catalog && catalog.filter((d) => d.sensitivity !== 'secret').every((d) => (p.domains[d.id] ?? 'off') === levelOf(d)) && grants.profile);

  return (
    <div className="card" style={{ padding: '22px 24px', gap: 14 }}>
      <div>
        <div className="card-kicker">What {first} can see</div>
        <div className="card-title" style={{ fontSize: 22, marginTop: 4 }}>{summary}</div>
        <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>Changes apply right away. {first}’s Little Dipper picks them up on its next sync, and every read is logged in your activity.</div>
      </div>

      <div>
        <div className="text-muted" style={{ fontSize: 12, marginBottom: 6 }}>Quick start</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PRESETS.map((p) => (
            <button key={p.id} title={p.hint} disabled={busy} onClick={() => applyPreset(p)}
              style={{ border: `1px solid ${activePreset?.id === p.id ? 'var(--color-accent)' : 'var(--color-divider)'}`, background: activePreset?.id === p.id ? 'var(--color-accent-100)' : 'transparent', color: activePreset?.id === p.id ? 'var(--color-accent-800)' : 'inherit', borderRadius: 999, padding: '6px 14px', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Profile */}
      <div style={{ display: 'grid', gap: 8 }}>
        <SubHead>Profile</SubHead>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderRadius: 24, background: 'var(--color-accent-2-100)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-accent-2-900)' }}>Basic profile</div>
            <div style={{ fontSize: 13, color: 'var(--color-accent-2-800)' }}>{grants.profile ? standard.map((f) => f.label).join(' · ') : `Off. ${first} only sees what you switch on below.`}</div>
          </div>
          <Toggle on={grants.profile} label="Share basic profile" onChange={() => { send({ profile: !grants.profile }); if (grants.profile) setExtraOpen(true); }} />
        </div>
        <button className="btn btn-ghost" onClick={() => setExtraOpen(!showExtra)} style={{ justifySelf: 'start', fontSize: 13 }}>
          {showExtra ? 'Hide extra profile fields' : extraOn ? `Extra profile fields · ${extraOn} shared` : 'Share an extra profile field…'}
        </button>
        {showExtra && (
          <div style={{ display: 'grid' }}>
            {extraRows.map((f) => (
              <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--color-divider)' }}>
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 14 }}>{f.label}</div><div className="text-muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.value || 'Not added'}</div></div>
                {c.requested.includes(f.key) && <span className="tag tag-accent">Requested</span>}
                <span className={`tag ${SENS[f.sensitivity][1]}`}>{SENS[f.sensitivity][0]}</span>
                <Toggle on={grants.fields.includes(f.key)} label={`Share ${f.label}`} onChange={() => toggleField(f)} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Life categories */}
      <div style={{ display: 'grid', gap: 8 }}>
        <SubHead>Life categories</SubHead>
        {!catalog ? <div className="text-muted" style={{ fontSize: 13 }}>Loading…</div> : GROUPS.map((g) => {
          const list = catalog.filter((d) => d.group === g.id);
          if (!list.length) return null;
          const on = list.filter((d) => dg[d.id]).length;
          const open = openGroups[g.id] ?? on > 0;
          return (
            <div key={g.id} style={{ borderRadius: 22, background: open ? 'var(--color-neutral-100)' : 'transparent', border: open ? 'none' : '1px solid var(--color-divider)' }}>
              <button className="bare" aria-expanded={open} onClick={() => setOpenGroups({ ...openGroups, [g.id]: !open })} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 16px' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: g.ink, flex: 'none' }} />
                <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{g.label}</span>
                <span className={on ? 'tag tag-accent-2' : 'text-muted'} style={{ fontSize: on ? 11 : 12 }}>{on ? `${on} of ${list.length} shared` : `${list.length} categories`}</span>
                <span aria-hidden style={{ transform: `rotate(${open ? 90 : 0}deg)`, transition: 'transform .15s', fontSize: 12 }}>›</span>
              </button>
              {open && (
                <div style={{ padding: '0 16px 8px' }}>
                  {list.map((d) => {
                    const lvl = levelOf(d);
                    return (
                      <div key={d.id} style={{ padding: '10px 0', borderTop: '1px solid var(--color-divider)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <Mono d={d} size={30} />
                          <div style={{ flex: 1, minWidth: 120 }}>
                            <div style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>{d.label}{d.sensitivity === 'secret' && <Lock style={{ color: 'var(--color-accent-700)' }} />}</div>
                            <div className="text-muted" style={{ fontSize: 12 }}>{d.count ? `${d.count} entr${d.count === 1 ? 'y' : 'ies'}${d.dated && d.currentCount ? ` · ${d.currentCount} current` : ''}` : 'Nothing added yet'}</div>
                          </div>
                          <Pills value={lvl} size={12} onChange={(v) => setLevel(d, v)}
                            options={d.dated ? [['off', 'Off'], ['current', 'Current'], ['all', 'All']] : [['off', 'Off'], ['all', 'Shared']]} />
                        </div>
                        {lvl !== 'off' && hasSecretParts(d) && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0 0 40px', fontSize: 12 }}>
                            <Lock style={{ color: 'var(--color-accent-700)' }} />
                            <span style={{ flex: 1 }} className="text-muted">Include secret details ({d.parts.filter((p) => p.sensitivity === 'secret').map((p) => p.label.toLowerCase()).join(', ')})</span>
                            <Toggle on={!!dg[d.id]?.includeSecret} label={`Include secret details of ${d.label}`} onChange={() => setLevel(d, lvl, !dg[d.id]?.includeSecret)} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

const SubHead = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--color-neutral-600)', marginTop: 4 }}>{children}</div>
);
