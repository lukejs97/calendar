// The agenda and search: Google events from every account plus Todoist
// tasks, as one sorted list. A port of src-tauri/src/agenda.rs and search.rs.
import type { Agenda, AgendaItem, SearchResults } from "../../src/api";
import type { Context } from "./env";
import { AppError, invalidInput, notSignedIn } from "./errors";
import { accessToken, errorText, findEvents } from "./google";
import { readAccounts, readTodoistToken } from "./store";
import * as todoist from "./todoist";
import { addDays, daysBetween, midnight, parseDay, today } from "./zone";

/** Longest range one request may cover. A year view needs 366 days. */
const MAX_RANGE_DAYS = 400;

/** Everything from local midnight on `from` up to (not including) local midnight on `to`. */
export async function load(ctx: Context, from: string, to: string): Promise<Agenda> {
  if (!parseDay(from) || !parseDay(to)) throw invalidInput("dates must be YYYY-MM-DD");
  const days = daysBetween(from, to);
  if (days < 1 || days > MAX_RANGE_DAYS) {
    throw invalidInput(`date range must be 1 to ${MAX_RANGE_DAYS} days long, got ${days}`);
  }
  const { items, warnings, accounts } = await collect(ctx, from, to);
  return { accounts, items: sortItems(items, ctx.zone), warnings, offlineSince: null };
}

/** Fetches every Google account and Todoist at the same time. */
async function collect(ctx: Context, from: string, to: string, query?: string) {
  const { env, zone } = ctx;
  const accounts = await readAccounts(env);
  if (!accounts.length) throw notSignedIn();
  const [start, end] = [midnight(from, zone), midnight(to, zone)];

  const [google, tasks] = await Promise.all([
    Promise.allSettled(
      accounts.map(async (account) => findEvents(await accessToken(env, account), account, start, end, query)),
    ),
    readTodoistToken(env).then((token) =>
      token ? todoist.tasksBetween(token, from, to, zone).then((t) => ({ ok: t }), (e: unknown) => ({ error: e })) : null,
    ),
  ]);

  const items: AgendaItem[] = [];
  const warnings: string[] = [];
  const signedIn: string[] = [];
  // A calendar shared between two of your accounts shows up in both; list its events once.
  const seen = new Set<string>();
  let firstError: unknown;
  let loadedAny = false;
  accounts.forEach((account, i) => {
    const result = google[i];
    if (result.status === "fulfilled") {
      for (const item of result.value.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          items.push(item);
        }
      }
      warnings.push(...result.value.warnings);
      signedIn.push(account.email);
      loadedAny = true;
    } else if (result.reason instanceof AppError && result.reason.kind === "notSignedIn") {
      // Its token stopped working, and it's been removed.
      warnings.push(`${account.email}: Google signed this account out. Add it again under Accounts.`);
      firstError ??= result.reason;
    } else {
      warnings.push(`${account.email}: ${errorText(result.reason)}`);
      firstError ??= result.reason;
      signedIn.push(account.email);
    }
  });
  // If one account fails, still show the others.
  if (!loadedAny && firstError) throw firstError;

  if (tasks && "ok" in tasks) items.push(...(query ? tasks.ok.filter((t) => matches(t, query)) : tasks.ok));
  // A Todoist problem shouldn't hide your calendar; show it as a warning.
  else if (tasks) warnings.push(`Todoist: ${errorText(tasks.error)}`);

  return { items, warnings, accounts: signedIn };
}

/** When an item starts and ends, in milliseconds. All-day items start at local midnight. */
function span(item: AgendaItem, zone: string): [number, number] {
  const at = (s: string) => (item.allDay ? midnight(s, zone).getTime() : Date.parse(s));
  const start = at(item.start);
  const end = item.end ? at(item.end) : start;
  return [start, Math.max(end, start + 1)];
}

/** By start; all-day items before timed ones starting at the same moment; then by title. */
function sortItems(items: AgendaItem[], zone: string): AgendaItem[] {
  const keyed = items.map((item) => ({ item, start: span(item, zone)[0] }));
  keyed.sort(
    (a, b) =>
      a.start - b.start || Number(b.item.allDay) - Number(a.item.allDay) || a.item.title.localeCompare(b.item.title),
  );
  return keyed.map((k) => k.item);
}

/** How far back and ahead search looks, and the most results on each side of now. */
const DAYS_AROUND = 365;
const MAX_EACH = 50;

export async function search(ctx: Context, query: string): Promise<SearchResults> {
  query = query.trim();
  if (!query) return { upcoming: [], past: [], offline: false, warnings: [] };
  const now = today(ctx.zone);
  const { items, warnings } = await collect(ctx, addDays(now, -DAYS_AROUND), addDays(now, DAYS_AROUND + 1), query);

  const nowMs = Date.now();
  const spans = new Map(items.map((item) => [item, span(item, ctx.zone)]));
  const upcoming = items.filter((i) => spans.get(i)![1] > nowMs).sort((a, b) => spans.get(a)![0] - spans.get(b)![0]);
  const past = items.filter((i) => spans.get(i)![1] <= nowMs).sort((a, b) => spans.get(b)![0] - spans.get(a)![0]);
  return { upcoming: upcoming.slice(0, MAX_EACH), past: past.slice(0, MAX_EACH), offline: false, warnings };
}

/** Whether every word of `query` appears in the item's title, place, notes or list name. */
function matches(item: AgendaItem, query: string): boolean {
  const text = [item.title, item.location, item.description, item.listName].filter(Boolean).join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).every((word) => text.includes(word));
}
