// Reading the person's own chats from the site they have open, the way the site's own pages do:
// same origin, same login. Each site lists chats newest-changed first, so a catch-up reads the list
// until it reaches chats it has seen (or the start of the sync window) and fetches only those.

// The list or a chat came back in a shape we don't know: the site changed its internal API.
export class ShapeError extends Error {}

export interface Account {
  changed(since: number, seen: Record<string, string>): Promise<string[]>; // ids, newest first
  chat(id: string): Promise<unknown>;
  about(): Promise<AboutField>; // where the "About me" block lives on this site
}

export interface AboutField {
  text: string;
  limit: number; // characters the site accepts in that field
  write(text: string): Promise<void>;
}

interface Listed {
  id: string;
  updated: number;
  skip: boolean; // temporary chats and chats marked not to be remembered
}

const time = (v: unknown): number =>
  typeof v === 'number' ? v * 1000 : typeof v === 'string' ? new Date(v).getTime() : NaN;

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url, location.href).pathname}`);
  return res.json();
}

// Walks pages until a chat is older than the window or already seen at that version.
async function collect(pages: AsyncGenerator<Listed[]>, since: number, seen: Record<string, string>, out: string[]): Promise<void> {
  for await (const page of pages) {
    for (const c of page) {
      if (c.updated < since) return;
      const known = seen[c.id] ? new Date(seen[c.id]!).getTime() : NaN;
      if (c.updated <= known) return;
      if (!c.skip && !out.includes(c.id)) out.push(c.id);
    }
  }
}

const MAX_PAGES = 30; // 3,000 chats per list is far past a year for nearly everyone

function chatgpt(): Account {
  let token: Promise<string> | undefined;
  const auth = async (): Promise<RequestInit> => {
    // Cookies alone get an empty list; the page itself sends the session's access token.
    token ??= (json('/api/auth/session') as Promise<{ accessToken?: string }>).then((s) => {
      if (!s.accessToken) throw new Error('not signed in');
      return s.accessToken;
    });
    return { headers: { Authorization: `Bearer ${await token}` } };
  };
  const listed = (items: unknown): Listed[] => {
    if (!Array.isArray(items)) throw new ShapeError('chatgpt.com conversation list has no items');
    return items.map((i: { id?: string; update_time?: unknown; is_temporary_chat?: boolean; is_do_not_remember?: boolean }) => {
      if (typeof i.id !== 'string' || Number.isNaN(time(i.update_time))) throw new ShapeError('chatgpt.com conversation without id or update_time');
      return { id: i.id, updated: time(i.update_time), skip: !!i.is_temporary_chat || !!i.is_do_not_remember };
    });
  };
  async function* main(): AsyncGenerator<Listed[]> {
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = (await json(`/backend-api/conversations?offset=${page * 100}&limit=100&order=updated`, await auth())) as { items?: unknown };
      const items = listed(r.items);
      yield items;
      if (items.length < 100) return;
    }
  }
  // Chats inside a project are not in the main list.
  async function* project(id: string): AsyncGenerator<Listed[]> {
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = (await json(`/backend-api/gizmos/${id}/conversations?cursor=${encodeURIComponent(cursor)}`, await auth())) as { items?: unknown; cursor?: string | null };
      yield listed(r.items);
      if (!r.cursor) return;
      cursor = r.cursor;
    }
  }
  async function projects(): Promise<string[]> {
    const ids: string[] = [];
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = (await json(`/backend-api/gizmos/snorlax/sidebar?cursor=${encodeURIComponent(cursor)}`, await auth())) as {
        items?: Array<{ gizmo?: { id?: string } }>;
        cursor?: string | null;
      };
      if (!Array.isArray(r.items)) throw new ShapeError('chatgpt.com project list has no items');
      ids.push(...r.items.map((i) => i.gizmo?.id).filter((id): id is string => typeof id === 'string'));
      if (!r.cursor) break;
      cursor = r.cursor;
    }
    return ids;
  }
  return {
    async changed(since, seen) {
      const out: string[] = [];
      await collect(main(), since, seen, out);
      for (const id of await projects()) await collect(project(id), since, seen, out);
      return out;
    },
    chat: async (id) => json(`/backend-api/conversation/${id}`, await auth()),
    // Custom instructions are one object; saving sends all of it back with only "More about you" changed.
    async about() {
      const current = (await json('/backend-api/user_system_messages', await auth())) as Record<string, unknown>;
      if (typeof current.other_user_message !== 'string') throw new ShapeError('chatgpt.com custom instructions without other_user_message');
      const { object: _, ...fields } = current;
      return {
        text: current.other_user_message,
        limit: 1500,
        write: async (text) => {
          const init = await auth();
          await json('/backend-api/user_system_messages', {
            ...init,
            method: 'POST',
            headers: { ...(init.headers as Record<string, string>), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...fields, other_user_message: text }),
          });
        },
      };
    },
  };
}

function claude(): Account {
  let org: Promise<string> | undefined;
  const orgId = () =>
    (org ??= (json('/api/organizations') as Promise<Array<{ uuid?: string; capabilities?: string[] }>>).then((orgs) => {
      if (!Array.isArray(orgs)) throw new ShapeError('claude.ai organization list is not a list');
      // Accounts can belong to several organizations (an API console one, say); chats live in the one that can chat.
      const id = (orgs.find((o) => o.capabilities?.includes('chat')) ?? orgs[0])?.uuid;
      if (!id) throw new Error('no claude.ai organization');
      return id;
    }));
  async function* pages(): AsyncGenerator<Listed[]> {
    for (let page = 0; page < MAX_PAGES; page++) {
      const items = await json(`/api/organizations/${await orgId()}/chat_conversations?limit=100&offset=${page * 100}`);
      if (!Array.isArray(items)) throw new ShapeError('claude.ai conversation list is not a list');
      yield items.map((i: { uuid?: string; updated_at?: string; is_temporary?: boolean }) => {
        if (typeof i.uuid !== 'string' || Number.isNaN(time(i.updated_at))) throw new ShapeError('claude.ai conversation without uuid or updated_at');
        return { id: i.uuid, updated: time(i.updated_at), skip: !!i.is_temporary };
      });
      if (items.length < 100) return;
    }
  }
  return {
    async changed(since, seen) {
      const out: string[] = [];
      await collect(pages(), since, seen, out);
      return out;
    },
    chat: async (id) => json(`/api/organizations/${await orgId()}/chat_conversations/${id}?tree=False&rendering_mode=messages`),
    async about() {
      const profile = (await json('/api/account_profile')) as { conversation_preferences?: unknown; conversation_preferences_cloud_max_chars?: unknown };
      const text = profile.conversation_preferences ?? '';
      if (typeof text !== 'string') throw new ShapeError('claude.ai profile without conversation_preferences');
      return {
        text,
        limit: typeof profile.conversation_preferences_cloud_max_chars === 'number' ? profile.conversation_preferences_cloud_max_chars : 4000,
        write: async (next) => {
          await json('/api/account_profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_preferences: next }) });
        },
      };
    },
  };
}

export function accountFor(host: string): Account | null {
  if (host === 'chatgpt.com') return chatgpt();
  if (host === 'claude.ai') return claude();
  return null;
}
