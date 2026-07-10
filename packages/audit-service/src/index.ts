import { createHash, randomUUID } from "node:crypto";

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  action: string;
  actor: string;
  projectId?: string;
  taskId?: string;
  destructive: boolean;
  networked: boolean;
  detail: Record<string, unknown>;
}

export function createAuditEvent(input: Omit<AuditEvent, "id" | "timestamp">): AuditEvent {
  return { id: randomUUID(), timestamp: new Date().toISOString(), ...input };
}

