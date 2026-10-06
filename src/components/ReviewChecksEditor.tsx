import { useRef, useState } from 'react';
import { Package, ToggleLeft, ToggleRight } from 'lucide-react';
import type { SandboxOverrides } from '../../shared/types';
import { editableReviewChecks, restoreReviewCheck, reviewCheckDraftPatch, type ReviewCheckDraft } from '../../shared/security-review-editor';
import { validateSecuritySettings } from '../../shared/security-settings';
import { translate } from '../i18n';
import './review-checks-editor.css';

export function ReviewChecksEditor({ value, en, onSave }: {
  value: NonNullable<SandboxOverrides['review']>; en: boolean;
  onSave: (patch: NonNullable<SandboxOverrides['review']>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<ReviewCheckDraft[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const copy = (zh: string, english: string) => en ? english : zh;
  const selected = drafts.find(check => check.id === selectedId);
  const name = (check: ReviewCheckDraft) => (en ? check.nameEn || check.name : check.name) || copy('未命名检查项', 'Untitled check');
  const update = (id: string, patch: Partial<ReviewCheckDraft>) => {
    setDrafts(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row));
    setError('');
  };
  const add = () => {
    const check: ReviewCheckDraft = {
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: '', focus: '', enabled: true, preset: false,
    };
    setDrafts(rows => [...rows, check]); setSelectedId(check.id); setError('');
  };
  const remove = (check: ReviewCheckDraft) => {
    if (check.preset) { update(check.id, { deleted: true, enabled: false }); return; }
    const index = drafts.findIndex(row => row.id === check.id);
    const next = drafts.filter(row => row.id !== check.id);
    setDrafts(next); setSelectedId(next[Math.min(index, next.length - 1)]?.id || ''); setError('');
  };
  const restore = (id: string) => {
    setDrafts(rows => rows.map(row => row.id === id ? restoreReviewCheck(row) : row)); setError('');
  };
  const save = () => {
    const patch = reviewCheckDraftPatch(drafts), issue = validateSecuritySettings({ review: { ...value, ...patch } });
    if (issue) { setError(translate(issue.key, issue.params)); return; }
    onSave(patch); setOpen(false);
  };
  return <>
    <button type="button" className="btn-ghost btn-xs security-review-edit-trigger" aria-expanded={open} onClick={() => {
      if (open) { setOpen(false); return; }
      const checks = editableReviewChecks(value);
      setDrafts(checks); setSelectedId(checks.find(check => !check.deleted)?.id || checks[0]?.id || '');
      setError(''); setOpen(true);
    }}>{copy('编辑', 'Edit')}</button>
    {open && <section className="security-review-editor security-review-check-manager" aria-label={copy('编辑预审检查项', 'Edit review checks')}>
      <div className="review-checks-editor-layout">
        <div className="review-checks-editor-sidebar">
          <div className="review-checks-editor-list" ref={listRef} role="listbox" aria-label={copy('预审检查项', 'Review checks')}>
            {drafts.map((check, index) => <div key={check.id} className={`review-checks-editor-item${selectedId === check.id ? ' selected' : ''}${!check.enabled || check.deleted ? ' inactive' : ''}`}
              data-check-id={check.id} role="option" aria-selected={selectedId === check.id} tabIndex={selectedId === check.id ? 0 : -1}
              onClick={() => { setSelectedId(check.id); setError(''); }}
              onKeyDown={event => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(check.id); return; }
                const nextIndex = event.key === 'ArrowDown' ? Math.min(drafts.length - 1, index + 1)
                  : event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? drafts.length - 1 : -1;
                if (nextIndex >= 0) {
                  event.preventDefault(); setSelectedId(drafts[nextIndex].id); setError('');
                  (listRef.current?.children[nextIndex] as HTMLElement | undefined)?.focus();
                }
              }}>
              <span className="review-checks-editor-item-name" title={name(check)}>{name(check)}</span>
              {check.preset && <Package size={11} className="review-checks-editor-preset" aria-label={copy('预置检查项', 'Preset check')}><title>{copy('预置检查项', 'Preset check')}</title></Package>}
              {check.deleted && <span className="review-checks-editor-deleted">{copy('已删除', 'Deleted')}</span>}
              <button type="button" className="review-checks-editor-toggle" aria-pressed={check.enabled && !check.deleted}
                aria-label={`${check.enabled && !check.deleted ? copy('禁用', 'Disable') : copy('启用', 'Enable')} ${name(check)}`}
                title={check.deleted ? copy('还原预置后可启用', 'Restore the preset to enable it') : check.enabled ? copy('点击禁用', 'Click to disable') : copy('点击启用', 'Click to enable')}
                disabled={check.deleted} onClick={event => { event.stopPropagation(); update(check.id, { enabled: !check.enabled }); }}>
                {check.enabled && !check.deleted ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
              </button>
            </div>)}
          </div>
          <button type="button" className="btn-ghost btn-xs review-checks-editor-add" disabled={drafts.length >= 20} onClick={add}>{copy('新增检查项', 'Add check')}</button>
          <button type="button" className="btn-ghost btn-xs review-checks-editor-restore-all" onClick={() => { setDrafts(rows => rows.map(restoreReviewCheck)); setError(''); }}>{copy('还原全部预置', 'Restore all presets')}</button>
        </div>
        <div className="review-checks-editor-form" data-selected-check-id={selected?.id}>
          {selected ? <>
            <div className="review-checks-editor-heading"><strong>{selected.preset ? copy('预置检查项', 'Preset check') : copy('自定义检查项', 'Custom check')}</strong>
              <span className="muted small">{selected.deleted ? copy('此预置检查项已删除，可以还原后重新编辑。', 'This preset is deleted. Restore it to edit it again.')
                : copy('设置检查内容，并在左侧启用或禁用。保存后生效。', 'Set the instructions and enable or disable checks in the list. Changes apply when saved.')}</span>
            </div>
            {!selected.deleted && <>
              <label>{copy('名称', 'Name')}<input aria-label={`${copy('检查项名称', 'Check name')} ${selected.id}`} value={selected.name} maxLength={80}
                onChange={event => update(selected.id, { name: event.target.value, nameEn: undefined })} /></label>
              <label>{copy('检查内容', 'Instructions')}<textarea aria-label={`${copy('检查内容', 'Check instructions')} ${selected.id}`} value={selected.focus} rows={8} maxLength={4000}
                onChange={event => update(selected.id, { focus: event.target.value })} /></label>
            </>}
            <div className="review-checks-editor-item-actions">
              {selected.preset && <button type="button" className="btn-ghost btn-xs" onClick={() => restore(selected.id)}>{copy('还原预置', 'Restore preset')}</button>}
              {!selected.deleted && <button type="button" className="btn-ghost btn-xs" onClick={() => remove(selected)}>{copy('删除', 'Delete')}</button>}
            </div>
          </> : <p className="review-checks-editor-empty">{copy('选择检查项进行编辑，或新增一个检查项。', 'Select a check to edit, or add a new check.')}</p>}
        </div>
      </div>
      {error && <p role="alert" className="security-error">{error}</p>}
      <div className="review-checks-editor-footer"><button type="button" className="btn-primary btn-xs" onClick={save}>{copy('保存检查项', 'Save checks')}</button><button type="button" className="btn-ghost btn-xs" onClick={() => setOpen(false)}>{copy('取消', 'Cancel')}</button></div>
    </section>}
  </>;
}
