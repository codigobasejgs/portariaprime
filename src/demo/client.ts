import { TENANT } from './mode';
import { CONCIERGE, STORAGE, nowIso, store } from './store';
import { HANDLERS } from './rpc';

/**
 * Local stand-in for the supabase-js client on /demonstracao. Same call shapes the real pages use;
 * reads/writes go to the in-memory store. Anything not listed fails closed (never reaches the network).
 */
type Row = Record<string, any>;
const DENY = { message: 'Indisponível na demonstração.', code: 'DEMO' };
const err = (message: string) => ({ message, code: 'DEMO' });

interface Table { rows: () => Row[]; insert?: (r: Row) => Row | { error: any }; update?: (r: Row, patch: Row) => void; remove?: (r: Row) => void; table?: string }
const ro = (rows: () => Row[]): Table => ({ rows });
const T = (table: string, t: Table): Table => ({ ...t, table });

const TABLES: Record<string, () => Table> = {
  tenants: () => ro(() => [{ id: TENANT, slug: 'demonstracao', name: 'Jardins Prime', timezone: 'America/Sao_Paulo', status: 'active', document: null,
    contact_email: 'contato@exemplo.invalid', contact_phone: null, created_at: '2026-01-01T12:00:00Z' }]),
  tenant_branding: () => ro(() => []),
  tenant_settings: () => T('settings', { rows: () => [store.s.settings], update: (r, p) => Object.assign(r, p) }),
  units: () => T('units', {
    rows: () => store.s.units,
    insert: (r) => {
      const label = String(r.label || '').trim(), block = r.block ? String(r.block).trim() : null;
      if (!label) return { error: err('Informe a unidade.') };
      if (store.s.units.some((u) => u.label.toUpperCase() === label.toUpperCase() && (u.block || '').toUpperCase() === (block || '').toUpperCase()))
        return { error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
      const u = { id: crypto.randomUUID(), tenant_id: TENANT, block, label, active: true };
      store.s.units.push(u); return u;
    },
    update: (r, p) => Object.assign(r, p),
  }),
  // ponytail: local changes live only in memory (STORAGE is a constant); persist in store.s if the demo needs it across reloads.
  storage_locations: () => T('storage', {
    rows: () => STORAGE.map((s) => Object.assign(s, { concierge_locations: { name: CONCIERGE[0].name } })),
    insert: (r) => { const s: any = { id: crypto.randomUUID(), tenant_id: TENANT, notes: null, capacity: 10, active: true, sort_order: STORAGE.length + 1, is_contingency: false, concierge_location_id: CONCIERGE[0].id, ...r }; STORAGE.push(s); return s; },
    update: (r, p) => Object.assign(r, p),
  }),
  concierge_locations: () => ro(() => CONCIERGE),
  profiles: () => T('profiles', {
    rows: () => store.s.users.map((u) => ({ id: u.id, full_name: u.full_name, email: u.email })),
    update: (r, p) => { const u = store.s.users.find((x) => x.id === r.id); if (u && r.id === store.userId && typeof p.full_name === 'string') u.full_name = p.full_name; },
  }),
  resident_contacts: () => T('contacts', {
    rows: () => store.s.contacts.map((c) => Object.assign(c, { tenant_id: TENANT })),
    insert: (r) => {
      if (!store.residents(r.unit_id).some((m) => m.user_id === store.userId)) return { error: err('Sem permissão.') };
      const c = { id: crypto.randomUUID(), user_id: store.userId, unit_id: r.unit_id, name: String(r.name || '').trim(), phone: r.phone || null, email: r.email || null,
        notify_whatsapp: false, notify_email: !!r.email, active: true };
      store.s.contacts.push(c); return c;
    },
    update: (r, p) => { if (r.user_id !== store.userId && store.user.role === 'morador' && !store.residents(r.unit_id).some((m) => m.user_id === store.userId)) return; Object.assign(r, p); },
  }),
  notifications: () => T('notifications', {
    rows: () => store.s.notifications.filter((n) => n.user_id === store.userId).map((n) => Object.assign(n, { tenant_id: TENANT })),
    update: (r, p) => { if ('read_at' in p) r.read_at = p.read_at; },
  }),
  package_attachments: () => ro(() => store.s.attachments),
  receipts: () => ro(() => store.s.receipts),
  invitations: () => ro(() => store.s.invitations.map((i) => Object.assign(i, { tenant_id: TENANT }))),
  push_subscriptions: () => ({ rows: () => [], remove: () => {} }),
  audit_logs: () => ro(() => []),
  device_enrollments: () => ro(() => []),
  billing_orders: () => ro(() => []),
  plans: () => ro(() => []),
  plan_prices: () => ro(() => []),
  plan_entitlements: () => ro(() => []),
};

const cmp = (a: any, b: any) => (a == null ? (b == null ? 0 : -1) : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0);
const pick = (r: Row, cols: string) => {
  if (!cols || cols.trim() === '*' || cols.includes('(')) return { ...r };
  const o: Row = {};
  for (const c of cols.split(',').map((x) => x.trim()).filter(Boolean)) o[c] = r[c];
  return o;
};

/** Chainable query: select/insert/update/delete + filters, awaitable like PostgrestBuilder. */
class Query implements PromiseLike<any> {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private cols = '*';
  private payload: any;
  private filters: ((r: Row) => boolean)[] = [];
  private orders: [string, boolean, boolean | undefined][] = [];
  private lim?: number; private off = 0; private end?: number;
  private one: '' | 'single' | 'maybe' = '';
  constructor(private name: string) {}
  select(cols = '*') { this.cols = cols; return this; }
  insert(v: any) { this.op = 'insert'; this.payload = v; return this; }
  update(v: any) { this.op = 'update'; this.payload = v; return this; }
  delete() { this.op = 'delete'; return this; }
  upsert() { this.op = 'insert'; this.payload = null; return this; }
  private f(fn: (r: Row) => boolean) { this.filters.push(fn); return this; }
  eq(c: string, v: any) { return this.f((r) => r[c] === v); }
  neq(c: string, v: any) { return this.f((r) => r[c] !== v); }
  is(c: string, v: any) { return this.f((r) => (r[c] ?? null) === v); }
  in(c: string, v: any[]) { return this.f((r) => v.includes(r[c])); }
  lt(c: string, v: any) { return this.f((r) => r[c] < v); }
  lte(c: string, v: any) { return this.f((r) => r[c] <= v); }
  gt(c: string, v: any) { return this.f((r) => r[c] > v); }
  gte(c: string, v: any) { return this.f((r) => r[c] >= v); }
  order(c: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) { this.orders.push([c, o.ascending !== false, o.nullsFirst]); return this; }
  limit(n: number) { this.lim = n; return this; }
  range(a: number, b: number) { this.off = a; this.end = b; return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  then<A = any, B = never>(ok?: ((v: any) => A | PromiseLike<A>) | null, bad?: ((e: any) => B | PromiseLike<B>) | null) {
    return Promise.resolve().then(() => this.run()).then(ok, bad);
  }
  private run(): { data: any; error: any; count?: number } {
    const def = TABLES[this.name]?.();
    if (!def) return { data: null, error: DENY };
    const changed = () => def.table && store.changed(def.table);
    if (this.op === 'insert') {
      if (!def.insert || this.payload == null) return { data: null, error: DENY };
      const out: Row[] = [];
      for (const r of [].concat(this.payload)) {
        const res: any = def.insert(r);
        if (res?.error) return { data: null, error: res.error };
        out.push(res);
      }
      changed();
      return this.shape(out.map((r) => pick(r, this.cols)));
    }
    const hit = def.rows().filter((r) => this.filters.every((fn) => fn(r)));
    if (this.op === 'update') {
      if (!def.update) return { data: null, error: DENY };
      for (const r of hit) def.update(r, this.payload);
      changed();
      return this.shape(hit.map((r) => pick(r, this.cols)));
    }
    if (this.op === 'delete') {
      if (!def.remove) return { data: null, error: DENY };
      for (const r of hit) def.remove(r);
      changed();
      return { data: null, error: null };
    }
    let rows = hit.slice();
    if (this.orders.length) rows.sort((a, b) => {
      for (const [c, asc, nf] of this.orders) {
        if ((a[c] == null) !== (b[c] == null)) return (a[c] == null) === (nf ?? !asc) ? -1 : 1;
        const d = cmp(a[c], b[c]); if (d) return asc ? d : -d;
      }
      return 0;
    });
    const count = rows.length;
    rows = rows.slice(this.off, this.end != null ? this.end + 1 : undefined);
    if (this.lim != null) rows = rows.slice(0, this.lim);
    return { ...this.shape(rows.map((r) => pick(r, this.cols))), count };
  }
  private shape(rows: Row[]) {
    if (this.one === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: err('Registro não encontrado.') };
    if (this.one === 'maybe') return rows.length > 1 ? { data: null, error: err('Mais de um registro.') } : { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
}

function session() {
  const u = store.user;
  return {
    access_token: 'demo-local', refresh_token: 'demo-local', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: { full_name: u.full_name },
      email_confirmed_at: '2026-01-01T12:00:00Z', created_at: '2026-01-01T12:00:00Z' },
  };
}

const denied = async () => ({ data: { user: null, session: null }, error: DENY });
const deniedAll = new Proxy({}, { get: () => denied });

type Channel = { on: (...a: any[]) => Channel; subscribe: (...a: any[]) => Channel; unsubscribe: () => Promise<'ok'> };

export function createDemoClient() {
  const chans = new Set<Channel>();
  const channel = (_name: string): Channel => {
    const hs: ((e: Event) => void)[] = [];
    const ch: Channel = {
      on(_type: string, opts: { table?: string }, cb: (p: unknown) => void) {
        hs.push((e) => { if (!opts?.table || (e as CustomEvent).detail === opts.table) cb({ eventType: '*', new: {}, old: {} }); });
        return ch;
      },
      subscribe(cb?: (s: string) => void) { hs.forEach((h) => addEventListener('pp-demo-change', h)); cb?.('SUBSCRIBED'); return ch; },
      async unsubscribe() { hs.forEach((h) => removeEventListener('pp-demo-change', h)); return 'ok'; },
    };
    chans.add(ch);
    return ch;
  };
  const priv = {
    async upload(path: string, blob: Blob) {
      if (!path.startsWith(`${TENANT}/`)) return { data: null, error: err('Caminho inválido.') };
      store.files.set(path, blob);
      return { data: { path }, error: null };
    },
    async createSignedUrl(path: string) {
      const b = store.files.get(path);
      return b ? { data: { signedUrl: URL.createObjectURL(b) }, error: null } : { data: null, error: err('Arquivo de exemplo indisponível nesta sessão.') };
    },
    async remove(paths: string[]) { paths.forEach((p) => store.files.delete(p)); return { data: [], error: null }; },
  };
  const deniedBucket = { upload: denied, createSignedUrl: denied, remove: denied, getPublicUrl: () => ({ data: { publicUrl: '' } }) };
  return {
    from: (name: string) => new Query(name),
    async rpc(fn: string, args: Record<string, any> = {}) {
      await Promise.resolve();
      const h = HANDLERS[fn];
      if (!h) return { data: null, error: DENY };
      try { return { data: h(args), error: null }; } catch (e: any) { return { data: null, error: err(e?.message || DENY.message) }; }
    },
    channel,
    async removeChannel(ch: Channel) { chans.delete(ch); return ch.unsubscribe(); },
    async removeAllChannels() { const all = [...chans]; chans.clear(); return Promise.all(all.map((c) => c.unsubscribe())); },
    storage: { from: (bucket: string) => (bucket === 'tenant-private' ? priv : deniedBucket) },
    functions: { invoke: denied },
    auth: {
      onAuthStateChange(cb: (event: string, s: any) => void) {
        const t = setTimeout(() => cb('SIGNED_IN', session()), 0);
        return { data: { subscription: { unsubscribe: () => clearTimeout(t) } } };
      },
      getSession: async () => ({ data: { session: session() }, error: null }),
      getUser: async () => ({ data: { user: session().user }, error: null }),
      refreshSession: async () => { const s = session(); return { data: { session: s, user: s.user }, error: null }; },
      signOut: async () => ({ error: null }),
      signInWithPassword: denied, signUp: denied, resetPasswordForEmail: denied, updateUser: denied,
      verifyOtp: denied, exchangeCodeForSession: denied, setSession: denied,
      mfa: deniedAll,
      startAutoRefresh: async () => {}, stopAutoRefresh: async () => {},
    },
    _now: nowIso,
  };
}
