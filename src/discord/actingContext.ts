import { AsyncLocalStorage } from "node:async_hooks";

// Per-call record of which bot is acting and in which server. enter() writes
// it once the target server resolves; the safety gate reads it to name the
// action ("Acting as X in Y") and to bind the confirm token to that bot, so a
// token minted for one bot cannot be spent as another.
//
// It lives in async-local storage rather than being threaded through every
// tool because it is a safety concern: a destructive tool that forgot to pass
// the acting bot would silently lose the wrong-server backstop. Setting it
// once in enter() and reading it once in the gate covers every tool uniformly,
// and each concurrent tool call gets its own isolated scope.

export interface ActingBot {
  bot: string;
  server: string;
}

interface ActingStore {
  acting?: ActingBot;
  // The server the call resolved to, with one bot or many. The confirmation
  // dialog names it so the person agreeing sees where the change lands, and
  // its id is part of what a confirm token is bound to.
  server?: string;
  serverId?: string;
  // Something the result should say that the tool itself does not know,
  // such as which of two bots in the server was taken and why.
  notes?: string[];
}

const storage = new AsyncLocalStorage<ActingStore>();

// Run a tool handler inside a fresh acting-context scope. guarded() wraps every
// handler in this, so enter() and the gate share one scope per call.
export function runWithActingContext<T>(fn: () => T): T {
  return storage.run({}, fn);
}

export function setActingBot(acting: ActingBot): void {
  const store = storage.getStore();
  if (store) store.acting = acting;
}

export function getActingBot(): ActingBot | undefined {
  return storage.getStore()?.acting;
}

export function setTargetServer(name: string, id?: string): void {
  const store = storage.getStore();
  if (store) {
    store.server = name;
    store.serverId = id;
  }
}

export function getTargetServerId(): string | undefined {
  return storage.getStore()?.serverId;
}

export function getTargetServer(): string | undefined {
  return storage.getStore()?.server;
}

export function addResultNote(note: string): void {
  const store = storage.getStore();
  if (!store) return;
  store.notes = store.notes ?? [];
  if (!store.notes.includes(note)) store.notes.push(note);
}

export function getResultNotes(): string[] {
  return storage.getStore()?.notes ?? [];
}
