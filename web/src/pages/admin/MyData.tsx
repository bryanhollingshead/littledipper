import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, DERIVED_LABEL, get, post, put, SENS, type Field, type Sensitivity } from '../../api';
import { Confirm, Dialog, ErrorNote, Loading, Pills, useAction, useAsync, type ConfirmCfg } from '../../ui';

const SECTIONS: [string, string][] = [['identity', 'Identity'], ['contact', 'Contact'], ['residence', 'Residence'], ['gov', 'Government IDs'], ['custom', 'Other']];
const SENS_OPTS: [Sensitivity, string][] = [['standard', 'Standard'], ['sensitive', 'Sensitive'], ['secret', 'Secret']];

type FieldsResp = { items: Field[]; basicProfileContacts: number };

export default function MyData() {
  const { data, error, reload } = useAsync(() => get<FieldsResp>('/api/v1/owner/fields'), []);
  const { run, busy } = useAction();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<(Field & { newValue: string; newSens: Sensitivity }) | null>(null);
  const [adding, setAdding] = useState<{ label: string; value: string; sensitivity: Sensitivity; section: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);

  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;

  const reveal = async (f: Field) => {
    if (revealed[f.key] !== undefined) {
      const { [f.key]: _, ...rest } = revealed;
      setRevealed(rest);
      return;
    }
    const r = await run(() => post<{ value: string }>(`/api/v1/owner/fields/${f.key}/reveal`));
    if (r) setRevealed({ ...revealed, [f.key]: r.value });
  };

  const saveEdit = async () => {
    if (!editing) return;
    const body: Record<string, unknown> = { sensitivity: editing.newSens };
    // Secret values start blank in the dialog; blank means "keep".
    if (!editing.derivedFrom && !(editing.sensitivity === 'secret' && editing.newValue === '')) body.value = editing.newValue;
    const r = await run(() => put(`/api/v1/owner/fields/${editing.key}`, body), `${editing.label} saved`);
    if (r) {
      setEditing(null);
      setRevealed({});
      reload();
    }
  };

  const toStandardWarning = editing && editing.newSens === 'standard' && editing.sensitivity !== 'standard' && data.basicProfileContacts > 0
    ? `This will be shared with ${data.basicProfileContacts} contact${data.basicProfileContacts === 1 ? '' : 's'} as part of your basic profile.` : '';

  return (
    <div data-screen-label="My data" style={{ maxWidth: 960 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <Link className="btn btn-ghost" to="/admin/life" style={{ marginBottom: 14 }}>← My life</Link>
          <h1>Profile basics</h1>
          <p className="text-muted" style={{ margin: 0, maxWidth: 620 }}>The core facts about you. Your basic profile (shared with every connection) and your public page are built from these. Histories like homes and jobs live in their own categories in My life.</p>
        </div>
        <button className="btn btn-secondary" onClick={() => setAdding({ label: '', value: '', sensitivity: 'sensitive', section: 'custom' })}>Add a field</button>
      </div>
      <div className="text-muted" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '18px 0 8px', fontSize: 12 }}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span className="tag tag-neutral">Standard</span>can be public</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span className="tag tag-accent-2">Sensitive</span>public only if you insist</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span className="tag tag-accent">Secret</span>never public; sharing needs confirmation</span>
      </div>
      {SECTIONS.map(([id, title]) => {
        const rows = data.items.filter((f) => f.section === id);
        if (!rows.length) return null;
        return (
          <div key={id} style={{ marginTop: 28 }}>
            <h4>{title}</h4>
            <div className="card" style={{ padding: '4px 22px', gap: 0 }}>
              {rows.map((f) => {
                const secret = f.sensitivity === 'secret';
                const shown = revealed[f.key] ?? f.value;
                return (
                  <div key={f.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px,190px) minmax(0,1fr) auto', gap: 16, alignItems: 'center', padding: '14px 0', borderBottom: '1px solid var(--color-divider)' }}>
                    <div className="text-muted" style={{ fontSize: 13 }}>{f.label}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                      <span style={{ fontSize: 15, fontFamily: secret ? 'var(--mono)' : 'inherit', overflowWrap: 'anywhere' }}>{shown || <span className="text-muted">Not added</span>}</span>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span className={`tag ${SENS[f.sensitivity][1]}`}>{SENS[f.sensitivity][0]}</span>
                        {f.public && <span className="tag tag-outline">Public</span>}
                        {f.derivedFrom && <span className="tag tag-neutral">From {DERIVED_LABEL[f.derivedFrom] || f.derivedFrom}</span>}
                        {!!f.sharedWith && <span className="tag tag-neutral">Shared with {f.sharedWith}</span>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {secret && f.hasValue && <button className="btn btn-ghost" onClick={() => reveal(f)} style={{ fontSize: 13 }}>{revealed[f.key] !== undefined ? 'Hide' : 'Reveal'}</button>}
                      <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setEditing({ ...f, newValue: secret ? '' : f.value, newSens: f.sensitivity })}>Edit</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {editing && (
        <Dialog title={`Edit ${editing.label}`} onClose={() => setEditing(null)} actions={<>
          {!editing.derivedFrom && <button className="btn btn-ghost" style={{ marginRight: 'auto' }} onClick={() => setConfirm({
            title: `Remove ${editing.label}?`, body: 'The value is deleted from your Little Dipper and anyone you shared it with stops seeing it.', cta: 'Remove',
            onConfirm: async () => { if (await run(() => del(`/api/v1/owner/fields/${editing.key}`), `${editing.label} removed`)) { setConfirm(null); setEditing(null); reload(); } },
          })}>Remove</button>}
          <button className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={saveEdit}>Save</button>
        </>}>
          <div className="field"><label htmlFor="fv">Value</label>
            <input id="fv" className="input" disabled={!!editing.derivedFrom} value={editing.newValue} placeholder={editing.sensitivity === 'secret' && editing.hasValue ? 'Leave blank to keep the current value' : ''} onChange={(e) => setEditing({ ...editing, newValue: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && saveEdit()} />
          </div>
          {editing.derivedFrom && <div className="text-muted" style={{ fontSize: 13 }}>This comes from {DERIVED_LABEL[editing.derivedFrom] || editing.derivedFrom}. Change it there and it updates here automatically. You can still set how sensitive it is.</div>}
          <div className="field"><label>Sensitivity</label><Pills value={editing.newSens} options={SENS_OPTS} onChange={(k) => setEditing({ ...editing, newSens: k })} /></div>
          {toStandardWarning && <div style={{ fontSize: 13, color: 'var(--color-accent-800)', background: 'var(--color-accent-100)', borderRadius: 16, padding: '10px 14px' }}>{toStandardWarning}</div>}
          {editing.newSens === 'secret' && editing.sensitivity !== 'secret' && <div className="text-muted" style={{ fontSize: 13 }}>Secret values are encrypted, hidden from your public profile, and each reveal is logged.</div>}
        </Dialog>
      )}

      {adding && (
        <Dialog title="Add a field" onClose={() => setAdding(null)} actions={<>
          <button className="btn btn-secondary" onClick={() => setAdding(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !adding.label.trim()} onClick={async () => { if (await run(() => post('/api/v1/owner/fields', adding), `${adding.label} added`)) { setAdding(null); reload(); } }}>Add field</button>
        </>}>
          <div className="field"><label htmlFor="al">Name</label><input id="al" className="input" placeholder="Passport number" value={adding.label} onChange={(e) => setAdding({ ...adding, label: e.target.value })} /></div>
          <div className="field"><label htmlFor="av">Value</label><input id="av" className="input" value={adding.value} onChange={(e) => setAdding({ ...adding, value: e.target.value })} /></div>
          <div className="field"><label>Section</label><Pills value={adding.section} options={SECTIONS.map(([k, l]) => [k, l === 'Other' ? 'Other' : l])} onChange={(k) => setAdding({ ...adding, section: k })} size={12} /></div>
          <div className="field"><label>Sensitivity</label><Pills value={adding.sensitivity} options={SENS_OPTS} onChange={(k) => setAdding({ ...adding, sensitivity: k })} /></div>
        </Dialog>
      )}
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
