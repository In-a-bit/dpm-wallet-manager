interface Props {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}

export function Pagination({ total, limit, offset, onChange }: Props) {
  if (total === 0) return null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="muted">
        {from}–{to} of {total}
      </span>
      <button type="button" className="small" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        Previous
      </button>
      <button type="button" className="small" disabled={to >= total} onClick={() => onChange(offset + limit)}>
        Next
      </button>
    </nav>
  );
}
