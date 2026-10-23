interface Props {
  hasNewer: boolean;
  hasOlder: boolean;
  onNewer: () => void;
  onOlder: () => void;
}

/** Newest-first keyset paging: there is no total or page number, only a way back and a way on. */
export function CursorPager({ hasNewer, hasOlder, onNewer, onOlder }: Props) {
  if (!hasNewer && !hasOlder) return null;
  return (
    <nav className="pagination" aria-label="Pagination">
      <button type="button" className="small" disabled={!hasNewer} onClick={onNewer}>
        Newer
      </button>
      <button type="button" className="small" disabled={!hasOlder} onClick={onOlder}>
        Older
      </button>
    </nav>
  );
}
