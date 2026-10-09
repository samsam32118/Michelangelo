/**
 * The right panel: the fidelity ladder, then tabs Brief (real labelled fields → brief.set), Rounds (option cards with
 * tradeoffs, cost, taste; Choose → round.decide, Comment → say), Chat (the log; input → say) and Next (advice).
 * All by the person. Lists re-render on change, except while the person is typing in them.
 */
import type { Brief, Round, RoundOption } from '../shared/types.js';
import { LEVEL_COST, LEVEL_NAMES } from '../shared/outline.js';
import { formatMs } from '../shared/time.js';
import type { App } from './app.js';
import { h, icon, store as ls } from './dom.js';
import { adviceFor, briefMissing, decidedLevel, spentMs } from './advice.js';

type Tab = 'brief' | 'rounds' | 'chat' | 'next';
const TABS: [Tab, string][] = [['brief', 'Brief'], ['rounds', 'Rounds'], ['chat', 'Chat'], ['next', 'Next']];
const TEXT_FIELDS: [keyof Brief, string, string, boolean][] = [
  ['goal', 'Goal', 'What should the video make people do or feel?', true], ['audience', 'Audience', 'Who is it for?', false],
  ['platform', 'Platform', 'shorts, reels, youtube, site…', false], ['length', 'Length', '30s', false],
];
const LIST_FIELDS: [keyof Brief, string, string][] = [
  ['tone', 'Tone', 'calm\nwarm'], ['mustHave', 'Must have', 'the trick in the first 3 s'], ['avoid', 'Avoid', 'stock-photo look'],
  ['success', 'Success looks like', 'a viewer could do the trick after one watch'], ['references', 'References', 'shape ids or paths'],
  ['questions', 'Open questions', 'questions the agent is asking you'],
];
const STATUS_LABEL: Record<Round['status'], string> = { open: 'open', proposed: 'waiting for you', decided: 'decided', dropped: 'dropped' };

export function installPanel(app: App, root: HTMLElement): { show(t: Tab): void } {
  let tab: Tab = (ls.get('mgl.tab') as Tab) || 'brief';
  let seenLog = Number(ls.get('mgl.seenLog') ?? 0);
  const tabButtons = new Map<Tab, HTMLButtonElement>(), panes = new Map<Tab, HTMLElement>(), badges = new Map<Tab, HTMLElement>();

  const ladder = h('ol', { class: 'ladder', 'aria-label': 'Fidelity ladder' });
  const spend = h('div', { class: 'spend', 'data-mgl': 'spend' });
  const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Panel' });
  for (const [t, label] of TABS) {
    const badge = h('span', { class: 'badge', 'aria-hidden': 'true' });
    const b = h('button', { role: 'tab', id: `tabbtn-${t}`, 'aria-controls': `tab-${t}`, 'data-mgl': `tab-${t}`, onclick: () => show(t) }, label, badge);
    tabButtons.set(t, b); badges.set(t, badge); tablist.append(b);
    panes.set(t, h('section', { role: 'tabpanel', id: `tab-${t}`, 'aria-labelledby': `tabbtn-${t}`, class: 'pane' }));
  }
  root.append(h('div', { class: 'panel-head' }, ladder, spend), tablist, ...panes.values());

  function show(t: Tab): void {
    tab = t;
    ls.set('mgl.tab', t);
    for (const [k, b] of tabButtons) { b.setAttribute('aria-selected', String(k === t)); b.tabIndex = k === t ? 0 : -1; panes.get(k)!.hidden = k !== t; }
    if (t === 'chat') { seenLog = app.store.board.log?.length ?? 0; ls.set('mgl.seenLog', String(seenLog)); renderBadges(); const l = panes.get('chat')!.querySelector('.log'); if (l) l.scrollTop = l.scrollHeight; }
  }

  // ---- brief: built once, values synced unless focused
  const briefPane = panes.get('brief')!;
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
  const form = h('form', { class: 'brief', 'aria-label': 'Brief', onsubmit: (e) => e.preventDefault() });
  const sendBrief = (k: string, v: unknown) => void app.send([{ op: 'brief.set', [k]: v } as never]);
  for (const [k, label, ph, big] of TEXT_FIELDS) {
    const el = big ? h('textarea', { id: `brief-${k}`, 'data-mgl': `brief-${k}`, placeholder: ph, rows: 2 }) : h('input', { id: `brief-${k}`, 'data-mgl': `brief-${k}`, placeholder: ph, type: 'text' });
    el.addEventListener('change', () => sendBrief(k, el.value.trim() || null));
    inputs.set(k, el);
    form.append(h('div', { class: 'field', 'data-field': k }, h('label', { for: `brief-${k}` }, label, h('span', { class: 'need' }, 'needed')), el));
  }
  for (const [k, label, ph] of LIST_FIELDS) {
    const el = h('textarea', { id: `brief-${k}`, 'data-mgl': `brief-${k}`, placeholder: ph, rows: 2, 'aria-describedby': 'brief-lists-hint' });
    el.addEventListener('change', () => { const v = el.value.split('\n').map((x) => x.trim()).filter(Boolean); sendBrief(k, v.length ? v : null); });
    inputs.set(k, el);
    form.append(h('div', { class: 'field', 'data-field': k }, h('label', { for: `brief-${k}` }, label, h('span', { class: 'need' }, 'needed')), el));
  }
  const cpu = h('input', { id: 'brief-cpuMin', 'data-mgl': 'brief-cpuMin', type: 'number', min: 0, step: 0.5, placeholder: '10' });
  cpu.addEventListener('change', () => sendBrief('budget', { cpuMin: cpu.value === '' ? null : Number(cpu.value) }));
  const maxLevel = h('select', { id: 'brief-maxLevel', 'data-mgl': 'brief-maxLevel' }, h('option', { value: '' }, 'any'), ...LEVEL_NAMES.map((n, i) => h('option', { value: String(i) }, `${i} · ${n}`)));
  maxLevel.addEventListener('change', () => sendBrief('budget', { maxLevel: maxLevel.value === '' ? null : Number(maxLevel.value) }));
  inputs.set('cpuMin', cpu); inputs.set('maxLevel', maxLevel);
  form.append(h('div', { class: 'row2' },
    h('div', { class: 'field' }, h('label', { for: 'brief-cpuMin' }, 'Budget (render min)'), cpu),
    h('div', { class: 'field' }, h('label', { for: 'brief-maxLevel' }, 'Highest level'), maxLevel)));
  form.append(h('p', { class: 'hint', id: 'brief-lists-hint' }, 'Lists: one item per line. Changes save when you leave a field.'));
  briefPane.append(form);

  function renderBrief(): void {
    const br = app.store.board.brief ?? {};
    const miss = new Set(briefMissing(app.store.board));
    for (const [k, el] of inputs) {
      const v = k === 'cpuMin' ? br.budget?.cpuMin : k === 'maxLevel' ? br.budget?.maxLevel : (br as Record<string, unknown>)[k];
      const text = Array.isArray(v) ? v.join('\n') : v === undefined ? '' : String(v);
      if (document.activeElement !== el && el.value !== text) el.value = text;
      el.closest('.field')?.classList.toggle('missing', miss.has(k));
    }
  }

  // ---- rounds
  const roundsPane = panes.get('rounds')!;
  const whyInputs = new Map<string, string>();
  function optionCard(r: Round, o: RoundOption): HTMLElement {
    const chosen = r.chosen === o.id, live = r.status === 'open' || r.status === 'proposed';
    const comment = h('div', { class: 'comment', hidden: true });
    const card = h('article', { class: `option${chosen ? ' chosen' : ''}`, 'aria-label': `Option ${o.id}: ${o.title}`, 'data-mgl': `option-${o.id}` },
      h('header', {}, h('strong', {}, o.title), h('span', { class: 'id' }, o.id), chosen ? h('span', { class: 'chip ok' }, 'chosen') : null),
      o.summary ? h('p', {}, o.summary) : null,
      o.tradeoffs ? h('p', { class: 'kv' }, h('b', {}, 'Tradeoffs '), o.tradeoffs) : h('p', { class: 'kv warnText' }, 'No tradeoffs stated yet.'),
      o.cost ? h('p', { class: 'kv' }, h('b', {}, 'Cost '), o.cost) : null,
      o.taste ? h('p', { class: 'kv' }, h('b', {}, 'Taste '), o.taste) : null,
      o.shapes?.length ? h('div', { class: 'shapes' }, ...o.shapes.map((id) => h('button', { class: 'chip link', 'aria-label': `Show ${id} on the board`, onclick: () => { app.select([id]); app.focus([id]); } }, id))) : null,
      live ? h('div', { class: 'actions' },
        h('button', { class: 'primary', 'data-mgl': `choose-${o.id}`, 'aria-label': `Choose ${o.title}`, onclick: () => void app.send([{ op: 'round.decide', round: r.id, chosen: o.id, ...(whyInputs.get(r.id) ? { why: whyInputs.get(r.id)! } : {}) }]) }, 'Choose'),
        h('button', { 'data-mgl': `comment-${o.id}`, 'aria-label': `Comment on ${o.title}`, onclick: () => { comment.hidden = !comment.hidden; comment.querySelector('textarea')?.focus(); } }, 'Comment')) : null,
      comment);
    const ta = h('textarea', { rows: 2, placeholder: `What do you think of "${o.title}"?`, 'aria-label': `Comment on ${o.id}`, 'data-mgl': `comment-input-${o.id}` });
    const send = () => { const t = ta.value.trim(); if (!t) return; void app.send([{ op: 'say', text: `On ${o.id} "${o.title}": ${t}` }]); ta.value = ''; comment.hidden = true; };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    comment.append(ta, h('button', { 'data-mgl': `comment-send-${o.id}`, onclick: send }, 'Send'));
    return card;
  }
  function renderRounds(): void {
    const rounds = [...(app.store.board.rounds ?? [])].reverse();
    const body: HTMLElement[] = [];
    if (!rounds.length) body.push(h('p', { class: 'empty' }, 'No rounds yet. The agent opens a round with a goal and a fidelity, then proposes 2–3 options with tradeoffs for you to choose from.'));
    for (const r of rounds) {
      const live = r.status === 'open' || r.status === 'proposed';
      const why = h('input', { type: 'text', placeholder: 'Why? (optional, sent with Choose)', 'aria-label': `Why (round ${r.id})`, 'data-mgl': `why-${r.id}`, value: whyInputs.get(r.id) ?? '' });
      why.addEventListener('input', () => whyInputs.set(r.id, why.value));
      body.push(h('section', { class: `round ${r.status}`, 'aria-label': `Round ${r.id}: ${r.goal}`, 'data-mgl': `round-${r.id}` },
        h('header', {}, h('span', { class: 'id' }, r.id), h('strong', {}, r.goal)),
        h('div', { class: 'meta' }, h('span', { class: 'chip' }, `L${r.fidelity} ${LEVEL_NAMES[r.fidelity] ?? ''}`), h('span', { class: `chip st-${r.status}` }, STATUS_LABEL[r.status])),
        r.notes ? h('p', { class: 'notes' }, r.notes) : null,
        ...(r.options ?? []).map((o) => optionCard(r, o)),
        live && (r.options?.length ?? 0) > 0 ? why : null,
        r.status === 'decided' && r.why ? h('p', { class: 'why' }, h('b', {}, 'Why: '), r.why) : null));
    }
    roundsPane.replaceChildren(...body);
  }

  // ---- chat
  const chatPane = panes.get('chat')!;
  const log = h('ol', { class: 'log', 'aria-label': 'Conversation', 'aria-live': 'polite' });
  const chatIn = h('textarea', { rows: 2, placeholder: 'Say something to the agent… (Enter to send)', 'aria-label': 'Message to the agent', 'data-mgl': 'chat-input' });
  const sendChat = () => { const t = chatIn.value.trim(); if (!t) return; chatIn.value = ''; void app.send([{ op: 'say', text: t }]); };
  chatIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  chatPane.append(log, h('div', { class: 'composer' }, chatIn, h('button', { class: 'primary icon-btn', 'aria-label': 'Send', 'data-mgl': 'chat-send', onclick: sendChat }, icon('send', 18))));
  function renderChat(): void {
    const entries = app.store.board.log ?? [];
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren(...(entries.length ? entries.map((m) => h('li', { class: `msg ${m.by}`, 'data-mgl': `msg-${m.id}` },
      h('span', { class: 'who' }, m.by === 'ai' ? 'AI' : 'You'), h('span', { class: 'text' }, m.text),
      m.at ? h('time', { datetime: m.at }, new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null)) : [h('li', { class: 'empty' }, 'Talk about intent, tradeoffs and taste here. The agent reads every message.')]));
    if (atEnd || tab === 'chat') log.scrollTop = log.scrollHeight;
    if (tab === 'chat') { seenLog = entries.length; ls.set('mgl.seenLog', String(seenLog)); }
  }

  // ---- next
  const nextPane = panes.get('next')!;
  function renderNext(): void {
    const adv = adviceFor(app.store.board, app.store.advice);
    nextPane.replaceChildren(h('ol', { class: 'advice', 'aria-label': 'Next steps' }, ...adv.map((a) => {
      const shapeIds = (a.ids ?? []).filter((id) => app.store.get(id));
      return h('li', { class: `adv ${a.level}` }, h('span', { class: `chip lv-${a.level}` }, a.level), h('span', {}, a.text),
        shapeIds.length ? h('button', { class: 'chip link', 'aria-label': `Show ${shapeIds.join(', ')}`, onclick: () => { app.select(shapeIds); app.focus(shapeIds); } }, 'show') : null,
        a.ids?.includes('brief') ? h('button', { class: 'chip link', onclick: () => show('brief') }, 'brief') : null);
    })));
  }

  function renderLadder(): void {
    const b = app.store.board, top = decidedLevel(b), active = (b.rounds ?? []).find((r) => r.status === 'open' || r.status === 'proposed');
    ladder.replaceChildren(...LEVEL_NAMES.map((n, i) => h('li', {
      class: `${i <= top ? 'done' : ''}${active?.fidelity === i ? ' active' : ''}${i === top + 1 ? ' next' : ''}`,
      title: `Level ${i} · ${n}: ${LEVEL_COST[i]}`, 'aria-label': `Level ${i} ${n}${i <= top ? ', decided' : ''}${active?.fidelity === i ? ', current round' : ''}. Typical cost ${LEVEL_COST[i]}`,
    }, h('span', { class: 'dot' }), h('span', { class: 'name' }, n))));
    const ms = spentMs(b), budget = b.brief?.budget?.cpuMin;
    const pct = budget ? Math.min(100, (ms / 60000 / budget) * 100) : 0;
    spend.replaceChildren(h('span', {}, `Spent ${formatMs(ms)}${budget ? ` of ${budget} render min` : ''}`), budget ? h('span', { class: `bar${pct > 80 ? ' hot' : ''}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct), 'aria-label': 'Budget used' }, meterFill(pct)) : '');
  }

  function renderBadges(): void {
    const b = app.store.board;
    const counts: Record<Tab, number> = {
      brief: briefMissing(b).length + (b.brief?.questions?.length ?? 0),
      rounds: (b.rounds ?? []).filter((r) => r.status === 'proposed').length,
      chat: Math.max(0, (b.log?.length ?? 0) - seenLog),
      next: adviceFor(b, app.store.advice).filter((a) => a.level === 'ask' || a.level === 'warn').length,
    };
    for (const [t, el] of badges) { el.textContent = counts[t] ? String(counts[t]) : ''; el.hidden = !counts[t]; }
  }

  /** do not rebuild a list under the person's cursor */
  const busy = (pane: HTMLElement) => pane.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement!.tagName);
  const deferred = new Set<() => void>();
  const guarded = (pane: HTMLElement, fn: () => void) => () => { if (busy(pane)) deferred.add(fn); else fn(); };
  root.addEventListener('focusout', () => setTimeout(() => { for (const fn of [...deferred]) { deferred.delete(fn); fn(); } }, 0));
  const all = [renderBrief, guarded(roundsPane, renderRounds), guarded(chatPane, renderChat), guarded(nextPane, renderNext), renderLadder, renderBadges];
  let queued = false;
  const render = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; for (const fn of all) fn(); }); };
  app.store.on((c) => { if (c === 'board' || c === 'advice') render(); });
  show(tab);
  render();
  return { show };
}

function meterFill(pct: number): HTMLElement { const i = h('i'); i.style.width = `${pct}%`; return i; }
