import type Database from "better-sqlite3";

export interface OAuthClientRecord {
  id: string;
  clientName?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  scope?: string;
  createdAt: string;
}

export interface AuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  resource?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: string;
  createdAt: string;
  consumedAt?: string;
  tokenResponseJson?: string;
}

export interface RefreshTokenRecord {
  tokenHash: string;
  familyId: string;
  clientId: string;
  scope: string;
  resource?: string;
  expiresAt: string;
  createdAt: string;
  rotatedAt?: string;
  rotationResponseJson?: string;
  revokedAt?: string;
}

interface ClientRow {
  id: string;
  client_name: string | null;
  redirect_uris_json: string;
  token_endpoint_auth_method: string;
  scope: string | null;
  created_at: string;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  resource: string | null;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: string;
  created_at: string;
  consumed_at: string | null;
  token_response_json: string | null;
}

interface RefreshRow {
  token_hash: string;
  family_id: string;
  client_id: string;
  scope: string;
  resource: string | null;
  expires_at: string;
  created_at: string;
  rotated_at: string | null;
  rotation_response_json: string | null;
  revoked_at: string | null;
}

function fromClientRow(row: ClientRow): OAuthClientRecord {
  return {
    id: row.id,
    ...(row.client_name ? { clientName: row.client_name } : {}),
    redirectUris: JSON.parse(row.redirect_uris_json) as string[],
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    ...(row.scope ? { scope: row.scope } : {}),
    createdAt: row.created_at
  };
}

function fromCodeRow(row: CodeRow): AuthorizationCodeRecord {
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    ...(row.resource ? { resource: row.resource } : {}),
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
    ...(row.token_response_json ? { tokenResponseJson: row.token_response_json } : {})
  };
}

function fromRefreshRow(row: RefreshRow): RefreshTokenRecord {
  return {
    tokenHash: row.token_hash,
    familyId: row.family_id,
    clientId: row.client_id,
    scope: row.scope,
    ...(row.resource ? { resource: row.resource } : {}),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    ...(row.rotated_at ? { rotatedAt: row.rotated_at } : {}),
    ...(row.rotation_response_json ? { rotationResponseJson: row.rotation_response_json } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {})
  };
}

export class OAuthStore {
  constructor(private readonly db: Database.Database) {}

  createClient(record: OAuthClientRecord): void {
    this.db.prepare(`
      INSERT INTO oauth_clients (id, client_name, redirect_uris_json, token_endpoint_auth_method, scope, created_at)
      VALUES (@id, @clientName, @redirectUrisJson, @tokenEndpointAuthMethod, @scope, @createdAt)
    `).run({
      id: record.id,
      clientName: record.clientName ?? null,
      redirectUrisJson: JSON.stringify(record.redirectUris),
      tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
      scope: record.scope ?? null,
      createdAt: record.createdAt
    });
  }

  getClient(id: string): OAuthClientRecord | undefined {
    const row = this.db.prepare("SELECT * FROM oauth_clients WHERE id=?").get(id) as ClientRow | undefined;
    return row ? fromClientRow(row) : undefined;
  }

  insertCode(record: AuthorizationCodeRecord): void {
    this.db.prepare(`
      INSERT INTO oauth_authorization_codes
        (code_hash, client_id, redirect_uri, scope, resource, code_challenge, code_challenge_method, expires_at, created_at)
      VALUES (@codeHash, @clientId, @redirectUri, @scope, @resource, @codeChallenge, @codeChallengeMethod, @expiresAt, @createdAt)
    `).run({
      codeHash: record.codeHash,
      clientId: record.clientId,
      redirectUri: record.redirectUri,
      scope: record.scope,
      resource: record.resource ?? null,
      codeChallenge: record.codeChallenge,
      codeChallengeMethod: record.codeChallengeMethod,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt
    });
  }

  getCode(codeHash: string): AuthorizationCodeRecord | undefined {
    const row = this.db.prepare("SELECT * FROM oauth_authorization_codes WHERE code_hash=?").get(codeHash) as CodeRow | undefined;
    return row ? fromCodeRow(row) : undefined;
  }

  consumeCodeAndIssueRefresh(input: { codeHash: string; consumedAt: string; tokenResponseJson: string; refreshToken: RefreshTokenRecord }): boolean {
    const updateCode = this.db.prepare(`
      UPDATE oauth_authorization_codes SET consumed_at=@consumedAt, token_response_json=@tokenResponseJson
      WHERE code_hash=@codeHash AND consumed_at IS NULL
    `);
    const insertRefresh = this.db.prepare(`
      INSERT INTO oauth_refresh_tokens (token_hash, family_id, client_id, scope, resource, expires_at, created_at)
      VALUES (@tokenHash, @familyId, @clientId, @scope, @resource, @expiresAt, @createdAt)
    `);
    const tx = this.db.transaction(() => {
      const info = updateCode.run({ codeHash: input.codeHash, consumedAt: input.consumedAt, tokenResponseJson: input.tokenResponseJson });
      if (info.changes === 0) return false;
      insertRefresh.run({
        tokenHash: input.refreshToken.tokenHash,
        familyId: input.refreshToken.familyId,
        clientId: input.refreshToken.clientId,
        scope: input.refreshToken.scope,
        resource: input.refreshToken.resource ?? null,
        expiresAt: input.refreshToken.expiresAt,
        createdAt: input.refreshToken.createdAt
      });
      return true;
    });
    return tx();
  }

  getRefreshToken(tokenHash: string): RefreshTokenRecord | undefined {
    const row = this.db.prepare("SELECT * FROM oauth_refresh_tokens WHERE token_hash=?").get(tokenHash) as RefreshRow | undefined;
    return row ? fromRefreshRow(row) : undefined;
  }

  rotateRefreshToken(input: { tokenHash: string; rotatedAt: string; rotationResponseJson: string; next: RefreshTokenRecord }): boolean {
    const updateOld = this.db.prepare(`
      UPDATE oauth_refresh_tokens SET rotated_at=@rotatedAt, rotation_response_json=@rotationResponseJson
      WHERE token_hash=@tokenHash AND rotated_at IS NULL AND revoked_at IS NULL
    `);
    const insertNext = this.db.prepare(`
      INSERT INTO oauth_refresh_tokens (token_hash, family_id, client_id, scope, resource, expires_at, created_at)
      VALUES (@tokenHash, @familyId, @clientId, @scope, @resource, @expiresAt, @createdAt)
    `);
    const tx = this.db.transaction(() => {
      const info = updateOld.run({ tokenHash: input.tokenHash, rotatedAt: input.rotatedAt, rotationResponseJson: input.rotationResponseJson });
      if (info.changes === 0) return false;
      insertNext.run({
        tokenHash: input.next.tokenHash,
        familyId: input.next.familyId,
        clientId: input.next.clientId,
        scope: input.next.scope,
        resource: input.next.resource ?? null,
        expiresAt: input.next.expiresAt,
        createdAt: input.next.createdAt
      });
      return true;
    });
    return tx();
  }

  revokeFamily(familyId: string): void {
    this.db.prepare("UPDATE oauth_refresh_tokens SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL")
      .run(new Date().toISOString(), familyId);
  }

  purgeExpired(): void {
    const now = Date.now();
    const codeCutoff = new Date(now - 5 * 60_000).toISOString();
    const rotationCutoff = new Date(now - 5 * 60_000).toISOString();
    const deadCutoff = new Date(now - 7 * 24 * 3_600_000).toISOString();
    this.db.prepare("DELETE FROM oauth_authorization_codes WHERE expires_at < ?").run(codeCutoff);
    this.db.prepare("UPDATE oauth_refresh_tokens SET rotation_response_json=NULL WHERE rotated_at IS NOT NULL AND rotated_at < ? AND rotation_response_json IS NOT NULL")
      .run(rotationCutoff);
    this.db.prepare("DELETE FROM oauth_refresh_tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR (expires_at < ?)").run(deadCutoff, deadCutoff);
  }
}
