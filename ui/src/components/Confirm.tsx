import { useState, type ReactNode } from "react";
import { Modal } from "./Modal";

interface Props {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/** Confirmation dialog whose confirm button stays disabled while the action runs. */
export function Confirm({ title, children, confirmLabel, danger, onConfirm, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={danger ? "danger" : "primary"} disabled={busy} onClick={run}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
