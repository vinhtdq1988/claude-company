import type { Server } from 'node:http';
import type { Socket } from 'node:net';

export function parseAllowlist(value: string | undefined): Set<string>;
export function parseTarget(authority: string | undefined): { host: string; port: number } | null;
export function isAllowed(
  target: { host: string; port: number } | null,
  allowlist: Set<string>,
  allowedPorts?: number[],
): boolean;
export function createEgressProxy(options: {
  allowlist: Set<string>;
  allowedPorts?: number[];
  log?: (entry: Record<string, unknown>) => void;
  dial?: (port: number, host: string, onConnect: () => void) => Socket;
}): Server;
