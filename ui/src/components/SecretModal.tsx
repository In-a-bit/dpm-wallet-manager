import type { MintedApiKey } from "../api";
import { CopyButton } from "./Copy";
import { Modal } from "./Modal";

/** Shows a freshly minted or revealed key once, with a copy button and a warning. */
export function SecretModal({ title, minted, onClose }: { title: string; minted: MintedApiKey; onClose: () => void }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="primary" onClick={onClose}>
          I have stored it
        </button>
      }
    >
      <p className="warning">
        Copy this key now and store it somewhere safe. Anyone with it can act with the <strong>{minted.role}</strong> role.
      </p>
      <p>
        <strong>{minted.name}</strong> <span className="muted">({minted.prefix})</span>
      </p>
      <div className="secret">
        <code>{minted.key}</code>
        <CopyButton value={minted.key} />
      </div>
    </Modal>
  );
}
