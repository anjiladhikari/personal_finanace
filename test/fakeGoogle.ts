import type { AuthorizeOutcome, AuthorizeRequest, GoogleAuthorizer } from '@/google/authorization';
import type { FetchLike, RequestInitLike, ResponseLike } from '@/google/http';
import { DRIVE_FILE_SCOPE, OPENID_SCOPE } from '@/google/scopes';

/**
 * In-memory stand-in for the Drive v3, Sheets v4 and OpenID userinfo REST
 * endpoints the app calls. It enforces the drive.file rule (an app sees only
 * files it created for that account), bearer tokens, scopes, trash and
 * deletion, and lets tests inject failures, including "committed on the
 * server but the response was lost".
 */

export interface FakeTab {
  sheetId: number;
  title: string;
  index: number;
  frozenRowCount: number;
  rows: unknown[][];
}

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  ownerSub: string;
  createdByApp: boolean;
  trashed: boolean;
  deleted: boolean;
  appProperties: Record<string, string>;
  createdTime: string;
  modifiedTime: string;
  tabs: FakeTab[];
  nextSheetId: number;
}

type FailureResponse = { status: number; reason?: string } | 'network' | 'timeout' | 'network_after_commit';

interface Failure {
  method?: string;
  pathIncludes: string;
  remaining: number;
  response: FailureResponse;
}

interface TokenRecord {
  sub: string;
  scopes: string[];
  valid: boolean;
}

export interface LoggedRequest {
  method: string;
  path: string;
  body: unknown;
}

const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

function respond(status: number, body: unknown): ResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function errorBody(status: number, reason: string) {
  return { error: { code: status, message: 'fake error', errors: [{ reason, domain: 'global' }] } };
}

function columnIndex(letters: string): number {
  return [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

function parseRange(range: string): { title: string; r0: number; c0: number; r1: number; c1: number } {
  const match = /^'((?:[^']|'')*)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (!match) throw new Error(`Fake Sheets cannot parse range ${range}`);
  const [, title = '', ca = 'A', ra = '1', cb = 'A', rb = '1'] = match;
  return {
    title: title.replaceAll("''", "'"),
    r0: Number(ra) - 1,
    c0: columnIndex(ca),
    r1: Number(rb) - 1,
    c1: columnIndex(cb),
  };
}

export class FakeGoogle {
  readonly accounts = new Map<string, { sub: string; email: string }>();
  readonly files = new Map<string, FakeFile>();
  readonly log: LoggedRequest[] = [];
  /** Simulates Drive ignoring appProperties in files.create. */
  dropAppPropertiesOnCreate = false;

  private readonly grants = new Map<string, Set<string>>();
  private readonly tokens = new Map<string, TokenRecord>();
  private failures: Failure[] = [];
  private counter = 0;
  private now = Date.parse('2026-11-22T00:00:00Z');

  addAccount(sub: string, email: string): void {
    this.accounts.set(sub, { sub, email });
  }

  grantsOf(sub: string): Set<string> {
    return this.grants.get(sub) ?? new Set();
  }

  grant(sub: string, scopes: readonly string[]): void {
    const set = this.grants.get(sub) ?? new Set<string>();
    scopes.forEach((s) => set.add(s));
    this.grants.set(sub, set);
  }

  /** The user removed this app's access in their Google account. */
  revoke(sub: string): void {
    this.grants.delete(sub);
    this.expireTokens(sub);
  }

  expireTokens(sub?: string): void {
    for (const token of this.tokens.values()) {
      if (sub === undefined || token.sub === sub) token.valid = false;
    }
  }

  issueToken(sub: string, scopes: readonly string[]): string {
    this.counter += 1;
    const token = `fake-token-${this.counter}`;
    this.tokens.set(token, { sub, scopes: [...scopes], valid: true });
    return token;
  }

  failNext(failure: { method?: string; pathIncludes: string; times?: number; response: FailureResponse }): void {
    const entry: Failure = { pathIncludes: failure.pathIncludes, remaining: failure.times ?? 1, response: failure.response };
    if (failure.method !== undefined) entry.method = failure.method;
    this.failures.push(entry);
  }

  /** A file this app created earlier (e.g. before a reinstall). */
  seedAppFile(ownerSub: string, init: Partial<Omit<FakeFile, 'id' | 'ownerSub'>> = {}): FakeFile {
    const file = this.newFile(ownerSub, init.name ?? 'My Expenses', init.appProperties ?? {});
    Object.assign(file, init);
    return file;
  }

  appFiles(sub: string): FakeFile[] {
    return [...this.files.values()].filter((f) => f.ownerSub === sub && f.createdByApp && !f.deleted);
  }

  requests(method: string, pathIncludes = ''): LoggedRequest[] {
    return this.log.filter((r) => r.method === method && r.path.includes(pathIncludes));
  }

  private newFile(ownerSub: string, name: string, appProperties: Record<string, string>): FakeFile {
    this.counter += 1;
    this.now += 60_000;
    const stamp = new Date(this.now).toISOString();
    const file: FakeFile = {
      id: `file-${this.counter}`,
      name,
      mimeType: SHEET_MIME,
      ownerSub,
      createdByApp: true,
      trashed: false,
      deleted: false,
      appProperties: { ...appProperties },
      createdTime: stamp,
      modifiedTime: stamp,
      tabs: [{ sheetId: 0, title: 'Sheet1', index: 0, frozenRowCount: 0, rows: [] }],
      nextSheetId: 1_000,
    };
    this.files.set(file.id, file);
    return file;
  }

  private touch(file: FakeFile): void {
    this.now += 1_000;
    file.modifiedTime = new Date(this.now).toISOString();
  }

  private driveJson(file: FakeFile) {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      trashed: file.trashed,
      createdTime: file.createdTime,
      modifiedTime: file.modifiedTime,
      appProperties: { ...file.appProperties },
    };
  }

  readonly fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    this.log.push({ method: init.method, path: parsed.pathname, body });

    const failure = this.failures.find(
      (f) => f.remaining > 0 && parsed.pathname.includes(f.pathIncludes) && (f.method === undefined || f.method === init.method),
    );
    if (failure !== undefined) {
      failure.remaining -= 1;
      const { response } = failure;
      if (response === 'network') throw new TypeError('Network request failed');
      if (response === 'timeout') return this.hang(init);
      if (response !== 'network_after_commit') {
        return respond(response.status, errorBody(response.status, response.reason ?? 'backendError'));
      }
      await this.route(parsed, init, body);
      throw new TypeError('Network request failed');
    }
    return this.route(parsed, init, body);
  };

  private hang(init: RequestInitLike): Promise<ResponseLike> {
    return new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }

  private authenticate(init: RequestInitLike): TokenRecord | null {
    const token = /^Bearer (.+)$/.exec(init.headers.Authorization ?? '')?.[1];
    const record = token === undefined ? undefined : this.tokens.get(token);
    return record?.valid ? record : null;
  }

  private visibleFile(id: string, sub: string): FakeFile | null {
    const file = this.files.get(decodeURIComponent(id));
    return file && !file.deleted && file.createdByApp && file.ownerSub === sub ? file : null;
  }

  private async route(url: URL, init: RequestInitLike, body: unknown): Promise<ResponseLike> {
    const auth = this.authenticate(init);
    if (auth === null) return respond(401, errorBody(401, 'authError'));
    const path = url.pathname;

    if (url.host === 'www.googleapis.com' && path === '/oauth2/v3/userinfo') {
      if (!auth.scopes.includes(OPENID_SCOPE)) return respond(403, errorBody(403, 'insufficientPermissions'));
      const account = this.accounts.get(auth.sub);
      return respond(200, { sub: auth.sub, email: account?.email, email_verified: true });
    }

    if (!auth.scopes.includes(DRIVE_FILE_SCOPE)) return respond(403, errorBody(403, 'insufficientPermissions'));

    if (url.host === 'www.googleapis.com' && path.startsWith('/drive/v3/files')) {
      return this.drive(url, init, body, auth.sub);
    }
    if (url.host === 'sheets.googleapis.com' && path.startsWith('/v4/spreadsheets/')) {
      return this.sheets(url, init, body, auth.sub);
    }
    return respond(404, errorBody(404, 'notFound'));
  }

  private drive(url: URL, init: RequestInitLike, body: unknown, sub: string): ResponseLike {
    const id = url.pathname.split('/')[4];
    if (id === undefined || id === '') {
      if (init.method === 'POST') {
        const meta = (body ?? {}) as { name?: string; mimeType?: string; appProperties?: Record<string, string> };
        const file = this.newFile(sub, meta.name ?? 'Untitled', this.dropAppPropertiesOnCreate ? {} : (meta.appProperties ?? {}));
        file.mimeType = meta.mimeType ?? SHEET_MIME;
        return respond(200, this.driveJson(file));
      }
      // files.list
      const q = url.searchParams.get('q') ?? '';
      const prop = /appProperties has \{ key='([^']+)' and value='([^']+)' \}/.exec(q);
      const trashed = /trashed=true/.test(q);
      const files = [...this.files.values()]
        .filter((f) => f.ownerSub === sub && f.createdByApp && !f.deleted && f.trashed === trashed)
        .filter((f) => prop === null || f.appProperties[prop[1] ?? ''] === prop[2])
        .sort((a, b) => a.createdTime.localeCompare(b.createdTime));
      return respond(200, { files: files.map((f) => this.driveJson(f)) });
    }

    const file = this.visibleFile(id, sub);
    if (file === null) return respond(404, errorBody(404, 'notFound'));
    if (init.method === 'PATCH') {
      const update = (body ?? {}) as { appProperties?: Record<string, string | null> };
      for (const [key, value] of Object.entries(update.appProperties ?? {})) {
        if (value === null) delete file.appProperties[key];
        else file.appProperties[key] = value;
      }
      this.touch(file);
    }
    return respond(200, this.driveJson(file));
  }

  private sheets(url: URL, init: RequestInitLike, body: unknown, sub: string): ResponseLike {
    const rest = url.pathname.slice('/v4/spreadsheets/'.length);
    const [idPart = '', ...tail] = rest.split('/');
    const batch = idPart.endsWith(':batchUpdate');
    const file = this.visibleFile(batch ? idPart.slice(0, -':batchUpdate'.length) : idPart, sub);
    if (file === null) return respond(404, errorBody(404, 'notFound'));

    if (batch && init.method === 'POST') return this.batchUpdate(file, body);

    if (tail[0] === 'values' && tail[1] !== undefined) {
      const range = parseRange(decodeURIComponent(tail[1]));
      const tab = file.tabs.find((t) => t.title === range.title);
      if (tab === undefined) return respond(400, errorBody(400, 'badRequest'));
      if (init.method === 'PUT') {
        const values = ((body ?? {}) as { values?: unknown[][] }).values ?? [];
        values.forEach((row, r) =>
          row.forEach((cell, c) => {
            const target = (tab.rows[range.r0 + r] ??= []);
            target[range.c0 + c] = cell;
          }),
        );
        this.touch(file);
        return respond(200, { updatedRange: decodeURIComponent(tail[1]) });
      }
      const slice: unknown[][] = [];
      for (let r = range.r0; r <= range.r1; r += 1) {
        const row = (tab.rows[r] ?? []).slice(range.c0, range.c1 + 1).map((cell) => cell ?? '');
        while (row.length > 0 && row[row.length - 1] === '') row.pop();
        slice.push(row);
      }
      while (slice.length > 0 && slice[slice.length - 1]?.length === 0) slice.pop();
      return respond(200, slice.length === 0 ? { range: tail[1] } : { range: tail[1], values: slice });
    }

    // spreadsheets.get
    return respond(200, {
      sheets: file.tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title, index: t.index } })),
    });
  }

  private batchUpdate(file: FakeFile, body: unknown): ResponseLike {
    const requests = ((body ?? {}) as { requests?: Record<string, any>[] }).requests ?? [];
    const replies: unknown[] = [];
    for (const request of requests) {
      if (request.updateSheetProperties) {
        const props = request.updateSheetProperties.properties;
        const tab = file.tabs.find((t) => t.sheetId === props.sheetId);
        if (tab === undefined) return respond(400, errorBody(400, 'badRequest'));
        if (props.title !== undefined) {
          if (file.tabs.some((t) => t !== tab && t.title === props.title)) {
            return respond(400, errorBody(400, 'badRequest'));
          }
          tab.title = props.title;
        }
        if (props.gridProperties?.frozenRowCount !== undefined) tab.frozenRowCount = props.gridProperties.frozenRowCount;
        replies.push({});
      } else if (request.addSheet) {
        const props = request.addSheet.properties;
        if (file.tabs.some((t) => t.title === props.title)) return respond(400, errorBody(400, 'badRequest'));
        const tab: FakeTab = {
          sheetId: file.nextSheetId++,
          title: props.title,
          index: file.tabs.length,
          frozenRowCount: props.gridProperties?.frozenRowCount ?? 0,
          rows: [],
        };
        file.tabs.push(tab);
        replies.push({ addSheet: { properties: { sheetId: tab.sheetId, title: tab.title, index: tab.index } } });
      } else {
        return respond(400, errorBody(400, 'badRequest'));
      }
    }
    this.touch(file);
    return respond(200, { replies });
  }
}

export type UserAction = 'approve' | 'cancel' | 'approve_without_drive';

/**
 * Simulates Google Play services' AuthorizationClient plus the user's taps
 * on Google's account chooser and consent screens.
 */
export class FakeAuthorizer implements GoogleAuthorizer {
  available = true;
  /** Accounts signed in on the device, by OpenID sub. */
  deviceAccounts: string[];
  /** Which account the user taps in the account chooser. */
  chooserPick: string | null = null;
  /** What the user does on the next consent screens (default: approve). */
  readonly userActions: UserAction[] = [];
  readonly calls: AuthorizeRequest[] = [];
  readonly clearedTokens: string[] = [];
  /** Throw this from authorize() (e.g. DEVELOPER_ERROR). */
  throwOnAuthorize: Error | null = null;
  private lastAccount: string | null = null;

  constructor(
    private readonly google: FakeGoogle,
    deviceAccounts: string[],
  ) {
    this.deviceAccounts = deviceAccounts;
  }

  async authorize(request: AuthorizeRequest): Promise<AuthorizeOutcome> {
    this.calls.push(request);
    if (this.throwOnAuthorize !== null) throw this.throwOnAuthorize;

    const byEmail = (email: string) =>
      this.deviceAccounts.find((sub) => this.google.accounts.get(sub)?.email === email);
    const pick = () => this.chooserPick ?? this.deviceAccounts[0];

    let sub: string | undefined;
    if (request.selectAccount) {
      if (!request.interactive) return { type: 'needs_user_interaction' };
      sub = pick();
    } else if (request.accountEmail !== null) {
      sub = byEmail(request.accountEmail) ?? (request.interactive ? pick() : undefined);
    } else if (this.lastAccount !== null) {
      sub = this.lastAccount;
    } else if (this.deviceAccounts.length === 1 || request.interactive) {
      sub = pick();
    }
    if (sub === undefined) return { type: 'needs_user_interaction' };

    const granted = this.google.grantsOf(sub);
    if (!request.scopes.every((s) => granted.has(s))) {
      if (!request.interactive) return { type: 'needs_user_interaction' };
      const action = this.userActions.shift() ?? 'approve';
      if (action === 'cancel') return { type: 'cancelled' };
      this.google.grant(
        sub,
        action === 'approve_without_drive' ? request.scopes.filter((s) => s !== DRIVE_FILE_SCOPE) : request.scopes,
      );
    }

    this.lastAccount = sub;
    const scopes = [...this.google.grantsOf(sub)].filter((s) => request.scopes.includes(s));
    return { type: 'success', accessToken: this.google.issueToken(sub, scopes), grantedScopes: scopes };
  }

  async clearToken(accessToken: string): Promise<void> {
    this.clearedTokens.push(accessToken);
  }

  async revokeAccess(accountEmail: string): Promise<void> {
    const sub = [...this.google.accounts.values()].find((a) => a.email === accountEmail)?.sub;
    if (sub !== undefined) this.google.revoke(sub);
  }
}
