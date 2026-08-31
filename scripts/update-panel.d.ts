export interface UpdatePanelRelease {
  version: string;
  digest: string;
  digestVerified: boolean;
}

export interface PanelLocalAuthentication {
  kind: string;
  authenticated: boolean;
}

export interface UpdatePanelRequest {
  command: "update";
  currentRelease: UpdatePanelRelease;
  localAuth: PanelLocalAuthentication;
  targetRelease: UpdatePanelRelease;
}

export interface UpdatePanelState {
  operation: "update";
  state: "running" | "completed" | "reverted" | "failed";
  result?: unknown;
  error?: string;
}

export interface UpdatePanelStateStore {
  append(state: UpdatePanelState): Promise<void> | void;
}

export interface UpdatePanel {
  requestUpdate(input: Omit<UpdatePanelRequest, "command">): Promise<unknown>;
}

export function createUpdatePanel(input: {
  terminalOperation?: (input: UpdatePanelRequest) => Promise<unknown> | unknown;
  stateStore: UpdatePanelStateStore;
}): UpdatePanel;
