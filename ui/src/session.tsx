import { createContext, useContext } from "react";
import type { SessionDto, UiRole } from "./api";

export interface SessionCtx {
  session: SessionDto;
  signOut: () => Promise<void>;
}

export const SessionContext = createContext<SessionCtx | null>(null);

export function useSession(): SessionCtx {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionContext");
  return ctx;
}

export function useRole(): UiRole {
  return useSession().session.user.role;
}

export const ROLE_LABEL: Record<UiRole, string> = { owner: "Owner", operator: "Operator", viewer: "Viewer" };
