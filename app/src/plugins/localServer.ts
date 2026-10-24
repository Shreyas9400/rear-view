// Capacitor registration of the LocalServer plugin (Java: app.smartrearview.rearcam.server.LocalServerPlugin).

import { registerPlugin } from '@capacitor/core';
import type { LocalServerApi } from '../server/streamPublisher';

export interface LocalServerInfo {
  running: boolean;
  ip: string;
  port: number;
  /** Viewer token: show on the rear screen only (QR or URL), never log. */
  token: string;
  sessionId: string;
  /** http://ip:port/#t=token (the link the QR code carries) */
  url: string;
  /** http://ip:port/ : the constant address; a browser that has opened the QR link once remembers the token (D-037). */
  baseUrl?: string;
  /** http://rearview.local:port/ when the name responder started (iPhone Bonjour); null otherwise. UNVERIFIED on the hotspot (D-040). */
  hostUrl?: string | null;
  candidates?: string[];
}

export interface LocalServerPluginApi extends LocalServerApi {
  start(o?: { port?: number; bindAddress?: string; streamW?: number; streamH?: number; targetFps?: number }): Promise<LocalServerInfo>;
  stop(): Promise<void>;
  revoke(): Promise<{ token: string; url: string }>;
  status(): Promise<{ running: boolean; viewers?: number; framesPublished?: number; port?: number; ip?: string }>;
}

export const LocalServerPlugin = registerPlugin<LocalServerPluginApi>('LocalServer');
