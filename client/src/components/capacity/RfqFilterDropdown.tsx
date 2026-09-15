import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';

type RfqOp = { id: number; label: string; machine_id: number; location: string | null };
type RfqPart = { id: number; label: string; operations: RfqOp[] };
type RfqProject = { id: number; name: string; parts: RfqPart[] };
type RfqClient = { client: string; projects: RfqProject[] };

export type RfqFilterDropdownProps = {
  /** Czy filtr RFQ jest aktywny (checkbox zaznaczony). */
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  /** Zaznaczone ID operacji RFQ. */
  selectedOpIds: number[];
  onSelectedOpIdsChange: (ids: number[]) => void;
};

type TipPos = { top: number; left: number; width: number; maxHeight: number };

export default function RfqFilterDropdown({
  enabled,
  onEnabledChange,
  selectedOpIds,
  onSelectedOpIdsChange,
}: RfqFilterDropdownProps) {
  const popId = useId();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<TipPos | null>(null);
  const [tree, setTree] = useState<RfqClient[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Expanded state for projects and parts
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(() => new Set());
  const [expandedParts, setExpandedParts] = useState<Set<number>>(() => new Set());

  const selectedSet = new Set(selectedOpIds);

  // Load tree when opened first time
  useEffect(() => {
    if (!open || tree !== null) return;
    setLoading(true);
    setError(null);
    api.projects
      .rfqFilterTree()
      .then((data) => {
        setTree(data.clients);
        // Auto-expand if only one project
        const allProjects = data.clients.flatMap((c) => c.projects);
        if (allProjects.length === 1) {
          setExpandedProjects(new Set([allProjects[0].id]));
        }
      })
      .catch((e) => setError(String(e?.message ?? 'Błąd ładowania')))
      .finally(() => setLoading(false));
  }, [open, tree]);

  const updatePos = () => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(520, Math.max(280, window.innerWidth - margin * 2));
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    const preferBelow = spaceBelow >= 180 || spaceBelow >= spaceAbove;
    const maxHeight = Math.min(480, Math.max(140, preferBelow ? spaceBelow : spaceAbove));
    let left = r.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    const top = preferBelow ? r.bottom + 4 : Math.max(margin, r.top - 4 - maxHeight);
    setPos({ top, left, width, maxHeight });
  };

  useEffect(() => {
    if (!open) { setPos(null); return; }
    updatePos();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = () => updatePos();
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        anchorRef.current && !anchorRef.current.contains(e.target as Node) &&
        popRef.current && !popRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Helpers for selection
  const allOpsInProject = (p: RfqProject) => p.parts.flatMap((pt) => pt.operations.map((o) => o.id));
  const allOpsInPart = (pt: RfqPart) => pt.operations.map((o) => o.id);

  const isPartAllSelected = (pt: RfqPart) => allOpsInPart(pt).every((id) => selectedSet.has(id));
  const isPartSomeSelected = (pt: RfqPart) => !isPartAllSelected(pt) && allOpsInPart(pt).some((id) => selectedSet.has(id));
  const isProjectAllSelected = (p: RfqProject) => allOpsInProject(p).every((id) => selectedSet.has(id));
  const isProjectSomeSelected = (p: RfqProject) => !isProjectAllSelected(p) && allOpsInProject(p).some((id) => selectedSet.has(id));

  const toggle = (opId: number) => {
    const next = new Set(selectedSet);
    if (next.has(opId)) next.delete(opId); else next.add(opId);
    onSelectedOpIdsChange([...next]);
  };
  const togglePart = (pt: RfqPart) => {
    const ids = allOpsInPart(pt);
    const allSel = isPartAllSelected(pt);
    const next = new Set(selectedSet);
    if (allSel) ids.forEach((id) => next.delete(id)); else ids.forEach((id) => next.add(id));
    onSelectedOpIdsChange([...next]);
  };
  const toggleProject = (p: RfqProject) => {
    const ids = allOpsInProject(p);
    const allSel = isProjectAllSelected(p);
    const next = new Set(selectedSet);
    if (allSel) ids.forEach((id) => next.delete(id)); else ids.forEach((id) => next.add(id));
    onSelectedOpIdsChange([...next]);
  };
  const selectAll = () => {
    if (!tree) return;
    const all = tree.flatMap((c) => c.projects).flatMap((p) => allOpsInProject(p));
    onSelectedOpIdsChange(all);
  };
  const selectNone = () => onSelectedOpIdsChange([]);

  const totalOps = tree ? tree.flatMap((c) => c.projects).flatMap((p) => allOpsInProject(p)).length : 0;
  const selectedCount = selectedOpIds.length;
  const summaryLabel = enabled
    ? (selectedCount === 0 ? 'Żaden' : selectedCount === totalOps ? 'Wszystkie' : `${selectedCount} op.`)
    : '';

  return (
    <div ref={anchorRef} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            onEnabledChange(e.target.checked);
            if (e.target.checked && !open) setOpen(true);
          }}
        />
        <span>Detale RFQ</span>
      </label>
      {enabled && (
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? popId : undefined}
          onClick={() => setOpen((o) => !o)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            border: '1px solid #bbb',
            borderRadius: 4,
            background: selectedCount > 0 ? '#e3f2fd' : '#fff',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: selectedCount > 0 ? 600 : 400,
            color: selectedCount > 0 ? '#1565c0' : '#333',
            minWidth: 72,
          }}
        >
          {summaryLabel || 'Wybierz…'}
          <span style={{ fontSize: 10 }}>{open ? '▲' : '▼'}</span>
        </button>
      )}

      {open && pos && enabled &&
        createPortal(
          <div
            ref={popRef}
            id={popId}
            role="dialog"
            aria-label="Filtr detali RFQ"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
              overflowY: 'auto',
              background: '#fff',
              border: '1px solid #bbb',
              borderRadius: 6,
              boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
              zIndex: 9999,
              fontSize: 13,
            }}
          >
            {/* Toolbar */}
            <div style={{ display: 'flex', gap: 8, padding: '6px 10px', borderBottom: '1px solid #e0e0e0', background: '#f5f5f5', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, flex: 1 }}>Projekty RFQ</span>
              <button type="button" onClick={selectAll} style={linkBtnStyle}>Zaznacz wszystkie</button>
              <button type="button" onClick={selectNone} style={linkBtnStyle}>Odznacz wszystkie</button>
            </div>

            {loading && <div style={{ padding: '12px 14px', color: '#888' }}>Ładowanie…</div>}
            {error && <div style={{ padding: '12px 14px', color: '#c62828' }}>{error}</div>}
            {tree && tree.length === 0 && <div style={{ padding: '12px 14px', color: '#888' }}>Brak projektów RFQ.</div>}

            {tree && tree.flatMap((c) => c.projects).map((project) => {
              const projSel = isProjectAllSelected(project);
              const projSome = isProjectSomeSelected(project);
              const projExpanded = expandedProjects.has(project.id);
              return (
                <div key={project.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  {/* Project row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: '#fafafa' }}>
                    <IndeterminateCheckbox
                      checked={projSel}
                      indeterminate={projSome}
                      onChange={() => toggleProject(project)}
                    />
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 11, color: '#666', lineHeight: 1 }}
                      onClick={() => setExpandedProjects((prev) => {
                        const n = new Set(prev);
                        n.has(project.id) ? n.delete(project.id) : n.add(project.id);
                        return n;
                      })}
                    >
                      {projExpanded ? '▾' : '▸'}
                    </button>
                    <span
                      style={{ fontWeight: 600, flex: 1, cursor: 'pointer' }}
                      onClick={() => setExpandedProjects((prev) => {
                        const n = new Set(prev);
                        n.has(project.id) ? n.delete(project.id) : n.add(project.id);
                        return n;
                      })}
                    >
                      {project.name}
                    </span>
                    <span style={{ color: '#888', fontSize: 11 }}>
                      {allOpsInProject(project).filter((id) => selectedSet.has(id)).length}/{allOpsInProject(project).length}
                    </span>
                  </div>

                  {/* Parts */}
                  {projExpanded && project.parts.map((part) => {
                    const partSel = isPartAllSelected(part);
                    const partSome = isPartSomeSelected(part);
                    const partExpanded = expandedParts.has(part.id);
                    const hasMultipleOps = part.operations.length > 1;
                    return (
                      <div key={part.id} style={{ borderTop: '1px solid #f0f0f0' }}>
                        {/* Part row */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px 4px 22px' }}>
                          <IndeterminateCheckbox
                            checked={partSel}
                            indeterminate={partSome}
                            onChange={() => togglePart(part)}
                          />
                          {hasMultipleOps && (
                            <button
                              type="button"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 10, color: '#888', lineHeight: 1 }}
                              onClick={() => setExpandedParts((prev) => {
                                const n = new Set(prev);
                                n.has(part.id) ? n.delete(part.id) : n.add(part.id);
                                return n;
                              })}
                            >
                              {partExpanded ? '▾' : '▸'}
                            </button>
                          )}
                          {!hasMultipleOps && <span style={{ width: 14 }} />}
                          <span
                            style={{ flex: 1, cursor: hasMultipleOps ? 'pointer' : 'default' }}
                            onClick={hasMultipleOps ? () => setExpandedParts((prev) => {
                              const n = new Set(prev);
                              n.has(part.id) ? n.delete(part.id) : n.add(part.id);
                              return n;
                            }) : undefined}
                          >
                            {part.label}
                          </span>
                          {!hasMultipleOps && (
                            <span style={{ color: '#888', fontSize: 11 }}>{part.operations[0]?.label ?? ''}</span>
                          )}
                        </div>

                        {/* Operations — tylko gdy wiele maszyn i rozwinięte */}
                        {hasMultipleOps && partExpanded && part.operations.map((op) => (
                          <div
                            key={op.id}
                            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px 3px 44px', background: '#fdfcf8' }}
                          >
                            <input
                              type="checkbox"
                              checked={selectedSet.has(op.id)}
                              onChange={() => toggle(op.id)}
                            />
                            <span style={{ color: '#555' }}>{op.label}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

const linkBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: '#1565c0',
  fontSize: 12,
  padding: '1px 4px',
  textDecoration: 'underline',
};

function IndeterminateCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input type="checkbox" ref={ref} checked={checked} onChange={onChange} />;
}
