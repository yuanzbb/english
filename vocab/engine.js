const PROGRESS_KEY = "language-vocab-progress";
const GRADES = new Set(["again", "hard", "good", "easy"]);
const LEARNED_GRADES = new Set(["good", "easy", "known", "learned"]);
const NOTEBOOK_GRADES = new Set(["again", "unknown", "hard"]);
const MIN_EASE = 1.3;
const MASTERED_INTERVAL = 21;
const DEFAULT_HARD_NAILS = 3;
const STRONG_SUFFIXES = [
  "ization", "isation", "iveness", "ability", "ibility", "fulness", "ations", "ation",
  "ition", "ments", "ment", "ness", "less", "ally", "edly", "ively", "ously", "ingly",
  "able", "ible", "ical", "ious", "uous", "eous", "ive", "ity", "ily", "ful", "ous",
  "ory", "ary", "ism", "ist", "ize", "ise", "ify", "ance", "ence", "ship", "hood", "ly",
].sort((a, b) => b.length - a.length);
const WEAK_SUFFIXES = ["ers", "ors", "ies", "ing", "er", "or", "ed", "es", "en", "al"];
const FAMILY_SUFFIXES = [...STRONG_SUFFIXES, ...WEAK_SUFFIXES].sort((a, b) => b.length - a.length);
const STRONG_SET = new Set(STRONG_SUFFIXES);
const WEAK_SET = new Set(WEAK_SUFFIXES);
const WEAK_LEFTOVERS = new Set(["", "s", "es", "ed", "d", "ing", "er", "est"]);
const POS_HEAD = /^(vt|vi|adj|adv|prep|conj|num|pron|art|aux|int|n|v)\.?\s*/i;

const store = {
  catalog: null,
  cards: new Map(),
  progress: null,
};

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function todayISO() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function addDays(iso, days) {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function pyRound(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const sign = number < 0 ? -1 : 1;
  const abs = Math.abs(number);
  const floor = Math.floor(abs);
  const frac = abs - floor;
  const whole = Math.abs(frac - 0.5) < 1e-9 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(abs);
  return sign * whole;
}

function clock() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

function readProgress() {
  try {
    const data = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "");
    if (data && data.version === 2 && data.lists) return data;
  } catch {
    /* 空进度 */
  }
  return { version: 2, active: "", lists: {} };
}

function writeProgress() {
  store.progress.version = 2;
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(store.progress));
}

function activeId() {
  const active = store.progress.active || store.catalog.active || "";
  if (!active || !store.catalog.lists[active]) {
    throw new ApiError("还没有当前词表");
  }
  return active;
}

function metaOf(listId) {
  const meta = store.catalog.lists[listId];
  if (!meta) throw new ApiError(`词表未注册：${listId}`);
  return meta;
}

function examOptions(meta) {
  return Object.entries(meta.subsets || {})
    .filter(([, spec]) => spec && spec.any_tags && spec.any_tags.length)
    .map(([id, spec]) => ({ id, label: spec.label || id }));
}

function examIds(meta) {
  return examOptions(meta).map((item) => item.id);
}

function parseHardMin(value, fallback = 1) {
  const nails = Number(value);
  if (!Number.isInteger(nails)) return fallback;
  if (nails < 1) return 1;
  if (nails > 3) return 3;
  return nails;
}

function parseHardLevels(value) {
  if (Number.isInteger(value)) {
    const minimum = parseHardMin(value, 1);
    return [1, 2, 3].filter((level) => level >= minimum);
  }
  const raw = Array.isArray(value) ? value : [];
  const levels = [];
  for (const item of raw) {
    const level = Number(item);
    if (level >= 1 && level <= 3 && !levels.includes(level)) levels.push(level);
  }
  return levels.sort((a, b) => a - b).length ? levels.sort((a, b) => a - b) : [1, 2, 3];
}

function normalizeExams(state, meta) {
  const allowed = examIds(meta);
  if (!allowed.length) return [];
  if (Array.isArray(state.exams)) {
    const cleaned = allowed.filter((exam) => state.exams.includes(exam));
    if (cleaned.length) return cleaned;
  }
  if (allowed.includes(state.subset)) return [state.subset];
  return [...allowed];
}

function examsLabel(exams, meta) {
  const options = examOptions(meta);
  const allowed = options.map((item) => item.id);
  if (!exams.length || allowed.every((exam) => exams.includes(exam))) return "全部";
  const labels = Object.fromEntries(options.map((item) => [item.id, item.label]));
  return allowed.filter((exam) => exams.includes(exam)).map((exam) => labels[exam]).join(" + ");
}

function cardMatchesExams(card, exams, allowed) {
  if (!exams.length || allowed.every((exam) => exams.includes(exam))) return true;
  const tags = new Set(card.tags || []);
  return exams.some((exam) => tags.has(exam));
}

function cardsOf(listId) {
  const cards = store.cards.get(listId);
  if (!cards) throw new ApiError("词表还没读进来");
  return cards;
}

function filteredCards(listId, exams) {
  const meta = metaOf(listId);
  const allowed = examIds(meta);
  const chosen = exams == null ? allowed : exams;
  return cardsOf(listId)
    .filter((card) => cardMatchesExams(card, chosen, allowed))
    .sort((a, b) => String(a.word || a.id).localeCompare(String(b.word || b.id)) || String(a.id).localeCompare(String(b.id)));
}

function indexCards(cards) {
  return Object.fromEntries(cards.map((card) => [card.id, card]));
}

function blankState(meta) {
  const subsets = meta.subsets || {};
  const subset = meta.default_subset || (subsets.full ? "full" : Object.keys(subsets)[0] || "full");
  return {
    subset,
    exams: [],
    new_per_session: 8,
    review_per_session: 8,
    cards: {},
    notebook: {},
    once_notebook: {},
    hard_min: 1,
    hard_levels: [1, 2, 3],
    log: [],
  };
}

function srsState(state, word) {
  return (
    state.cards[word] || {
      status: "new",
      ease: 2.5,
      interval: 0,
      reps: 0,
      lapses: 0,
      due: null,
      last: null,
      history: [],
    }
  );
}

function isLearned(cardState) {
  return cardState.status === "mastered";
}

function learnedRecord(previous, when, grade) {
  return {
    status: "mastered",
    ease: 2.8,
    interval: MASTERED_INTERVAL,
    reps: Math.max(2, Number(previous.reps) || 0),
    lapses: Number(previous.lapses) || 0,
    due: addDays(when, MASTERED_INTERVAL),
    last: when,
    history: [...(previous.history || []), grade],
  };
}

function nailsOf(entry) {
  if (!entry || entry.nails == null) return DEFAULT_HARD_NAILS;
  const nails = Number(entry.nails);
  if (!Number.isFinite(nails) || nails < 1) return DEFAULT_HARD_NAILS;
  return Math.min(3, nails);
}

function notebookMap(state) {
  if (!state.notebook || typeof state.notebook !== "object") state.notebook = {};
  return state.notebook;
}

function onceMap(state) {
  if (!state.once_notebook || typeof state.once_notebook !== "object") state.once_notebook = {};
  return state.once_notebook;
}

function hardNails(state, word) {
  return nailsOf(onceMap(state)[word]);
}

function isHardWord(state, word) {
  if (notebookMap(state)[word]) return false;
  return Boolean(onceMap(state)[word]) && hardNails(state, word) >= 1;
}

function migratePiles(state) {
  if (state.piles === 1) return false;
  const when = todayISO();
  const book = notebookMap(state);
  for (const [word, card] of Object.entries(state.cards || {})) {
    const history = card.history || [];
    const last = history[history.length - 1] || "";
    if (card.status === "mastered" || LEARNED_GRADES.has(last)) {
      if (card.status !== "mastered") {
        state.cards[word] = {
          ...card,
          status: "mastered",
          interval: Math.max(Number(card.interval) || 0, MASTERED_INTERVAL),
          due: addDays(when, MASTERED_INTERVAL),
        };
      }
      delete book[word];
    } else if (NOTEBOOK_GRADES.has(last) && !book[word]) {
      const lastDay = String(card.last || when).slice(0, 10);
      book[word] = { added: lastDay, last: lastDay, hits: Math.max(1, Number(card.lapses) || 1) };
    }
  }
  state.piles = 1;
  return true;
}

function migrateStamps(state) {
  if (state.stamps === 1) return false;
  const once = onceMap(state);
  const book = notebookMap(state);
  const when = todayISO();
  for (const [word, entry] of Object.entries(book)) {
    if (once[word]) continue;
    once[word] = {
      first: entry.added || when,
      last: entry.last || when,
      hits: Math.max(1, Number(entry.hits) || 1),
    };
  }
  for (const [word, card] of Object.entries(state.cards || {})) {
    const history = card.history || [];
    if (once[word] || !history.some((grade) => NOTEBOOK_GRADES.has(grade))) continue;
    const lastDay = String(card.last || when).slice(0, 10);
    once[word] = { first: lastDay, last: lastDay, hits: Math.max(1, Number(card.lapses) || 1) };
  }
  state.stamps = 1;
  return true;
}

function liftZeroNails(state) {
  const once = onceMap(state);
  let dirty = false;
  for (const [word, entry] of Object.entries(once)) {
    if (!entry || entry.nails == null) continue;
    const nails = Number(entry.nails);
    if (!Number.isFinite(nails) || nails > 0) continue;
    entry.nails = DEFAULT_HARD_NAILS;
    once[word] = entry;
    dirty = true;
  }
  return dirty;
}

function graduateOrphanedOnce(state) {
  const book = notebookMap(state);
  let dirty = false;
  const when = todayISO();
  for (const word of Object.keys(onceMap(state))) {
    if (book[word] || isLearned(srsState(state, word))) continue;
    state.cards[word] = learnedRecord(srsState(state, word), when, "drop-notebook");
    dirty = true;
  }
  return dirty;
}

function listState(listId) {
  const meta = metaOf(listId);
  if (!store.progress.lists[listId]) store.progress.lists[listId] = blankState(meta);
  const state = store.progress.lists[listId];
  const fallback = blankState(meta);
  state.subset = state.subset || fallback.subset;
  state.new_per_session = state.new_per_session || 8;
  state.review_per_session = state.review_per_session || 8;
  state.cards = state.cards || {};
  state.notebook = state.notebook || {};
  state.once_notebook = state.once_notebook || {};
  state.log = state.log || [];
  state.hard_min = parseHardMin(state.hard_min, 1);
  state.hard_levels = state.hard_levels == null ? parseHardLevels(state.hard_min) : parseHardLevels(state.hard_levels);
  state.exams = normalizeExams(state, meta);
  const dirty = [migratePiles(state), migrateStamps(state), liftZeroNails(state), graduateOrphanedOnce(state)].some(Boolean);
  if (dirty) writeProgress();
  return state;
}

function sessionContext(listId, state) {
  const meta = metaOf(listId);
  const exams = normalizeExams(state, meta);
  return {
    list: listId,
    name: meta.name || listId,
    level: meta.level || meta.name || listId,
    subset: state.subset,
    subset_label: examsLabel(exams, meta),
    exams,
    hard_min: parseHardMin(state.hard_min, 1),
    hard_levels: parseHardLevels(state.hard_levels || state.hard_min),
  };
}

function splitPiles(cards, state) {
  const book = notebookMap(state);
  const learned = [];
  const notebook = [];
  const fresh = [];
  const hard = [];
  for (const card of cards) {
    if (isLearned(srsState(state, card.id))) {
      learned.push(card);
      if (isHardWord(state, card.id)) hard.push({ ...card, nails: hardNails(state, card.id) });
    } else if (book[card.id]) notebook.push(card);
    else fresh.push(card);
  }
  return { learned, notebook, fresh, hard };
}

function pileCounts(piles) {
  const known = piles.learned.length - piles.hard.length;
  return {
    total: known + piles.notebook.length + piles.hard.length + piles.fresh.length,
    learned: known,
    notebook: piles.notebook.length,
    fresh: piles.fresh.length,
    hard: piles.hard.length,
  };
}

function examProgress(listId, state) {
  const meta = metaOf(listId);
  const book = notebookMap(state);
  const rows = [];
  for (const option of examOptions(meta)) {
    let learned = 0;
    let notebook = 0;
    let fresh = 0;
    let hard = 0;
    for (const card of cardsOf(listId)) {
      if (!(card.tags || []).includes(option.id)) continue;
      if (isHardWord(state, card.id) && isLearned(srsState(state, card.id))) hard += 1;
      else if (isLearned(srsState(state, card.id))) learned += 1;
      else if (book[card.id]) notebook += 1;
      else fresh += 1;
    }
    rows.push({
      id: option.id,
      label: option.label,
      total: learned + notebook + hard + fresh,
      learned,
      notebook,
      fresh,
      hard,
    });
  }
  return rows;
}

function overallProgress(listId, state) {
  const seen = new Set();
  const unique = [];
  for (const card of cardsOf(listId)) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    unique.push(card);
  }
  return pileCounts(splitPiles(unique, state));
}

function due(cardState, when) {
  if (cardState.status === "new" || !cardState.due) return false;
  return cardState.due.slice(0, 10) <= when;
}

function streak(state) {
  const days = [...new Set(state.log.map((row) => row.date).filter(Boolean))].sort();
  if (!days.length) return 0;
  let cursor = todayISO();
  const yesterday = addDays(cursor, -1);
  if (days[days.length - 1] !== cursor && days[days.length - 1] !== yesterday) return 0;
  if (days[days.length - 1] !== cursor) cursor = yesterday;
  const have = new Set(days);
  let count = 0;
  while (have.has(cursor)) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

function summarize(listId) {
  const id = listId || activeId();
  const state = listState(id);
  const cards = filteredCards(id, state.exams);
  const piles = splitPiles(cards, state);
  const counts = { new: 0, learning: 0, review: 0, mastered: 0, due: 0 };
  const weak = [];
  const when = todayISO();
  for (const card of cards) {
    const cardState = srsState(state, card.id);
    counts[cardState.status] = (counts[cardState.status] || 0) + 1;
    if (due(cardState, when)) counts.due += 1;
    if (cardState.lapses) weak.push([Number(cardState.lapses), card.id]);
  }
  weak.sort((a, b) => b[0] - a[0]);
  return {
    date: when,
    ...sessionContext(id, state),
    total: cards.length,
    counts,
    learned: piles.learned.length,
    notebook: piles.notebook.length,
    fresh: piles.fresh.length,
    hard: piles.hard.length,
    progress: {
      total: cards.length,
      learned: piles.learned.length,
      notebook: piles.notebook.length,
      fresh: piles.fresh.length,
      hard: piles.hard.length,
    },
    exam_progress: examProgress(id, state),
    overall_progress: overallProgress(id, state),
    streak: streak(state),
    settings: {
      new_per_session: state.new_per_session,
      review_per_session: state.review_per_session,
    },
    weak: weak.slice(0, 8).map(([, word]) => word),
    sessions_today: state.log.filter((row) => row.date === when).length,
  };
}

function shuffle(list) {
  const items = [...list];
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function examTagLabels(card, meta) {
  const present = new Set(card.tags || []);
  return examOptions(meta).filter((item) => present.has(item.id)).map((item) => item.label);
}

function pickSession(mode, count) {
  const listId = activeId();
  const state = listState(listId);
  const piles = splitPiles(filteredCards(listId, state.exams), state);
  const limit = count || 20;
  let pool;
  let chosen;
  if (mode === "notebook" || mode === "review") {
    pool = shuffle(piles.notebook);
    chosen = "notebook";
  } else if (mode === "hard" || mode === "once") {
    const levels = new Set(parseHardLevels(state.hard_levels || state.hard_min));
    pool = shuffle(piles.hard.filter((card) => levels.has(Number(card.nails) || DEFAULT_HARD_NAILS)));
    chosen = "hard";
  } else {
    pool = piles.fresh;
    chosen = "quiz";
  }
  const meta = metaOf(listId);
  const picked = pool.slice(0, limit).map((card) => ({
    ...card,
    srs: srsState(state, card.id),
    exams: examTagLabels(card, meta),
  }));
  return {
    date: todayISO(),
    mode: chosen,
    ...sessionContext(listId, state),
    cards: picked,
    pool: {
      total: piles.learned.length + piles.notebook.length + piles.fresh.length,
      learned: piles.learned.length,
      notebook: piles.notebook.length,
      fresh: piles.fresh.length,
      hard: piles.hard.length,
      picked: picked.length,
    },
  };
}

function requireCard(word) {
  const listId = activeId();
  const key = String(word || "").toLowerCase().trim();
  const card = indexCards(cardsOf(listId))[key];
  if (!card) throw new ApiError(`当前词表没有：${key || word}`);
  return { listId, key, card };
}

function appendLog(state, word, grade) {
  state.log.push({ date: todayISO(), time: clock(), word, grade });
  if (state.log.length > 4000) state.log = state.log.slice(-4000);
}

function applyGrade(cardState, grade, when) {
  let ease = Number(cardState.ease) || 2.5;
  let interval = Number(cardState.interval) || 0;
  let reps = Number(cardState.reps) || 0;
  let lapses = Number(cardState.lapses) || 0;
  const history = [...(cardState.history || []), grade].slice(-20);
  let dueDay;
  let status;
  if (grade === "again" || grade === "unknown") {
    reps = 0;
    interval = 0;
    lapses += 1;
    ease = Math.max(MIN_EASE, ease - 0.2);
    dueDay = when;
    status = "learning";
  } else if (grade === "hard") {
    ease = Math.max(MIN_EASE, ease - 0.15);
    interval = interval <= 0 ? 1 : Math.max(1, pyRound(interval * 1.2));
    reps += 1;
    dueDay = addDays(when, interval);
    status = "review";
  } else if (grade === "good") {
    if (reps === 0) interval = 1;
    else if (reps === 1) interval = 3;
    else interval = Math.max(2, pyRound(interval * ease));
    reps += 1;
    dueDay = addDays(when, interval);
    status = "review";
  } else {
    ease = Math.min(3, ease + 0.15);
    interval = interval <= 0 ? 4 : Math.max(4, pyRound(interval * ease * 1.3));
    reps += 1;
    dueDay = addDays(when, interval);
    status = "review";
  }
  if (interval >= MASTERED_INTERVAL && (grade === "good" || grade === "easy")) status = "mastered";
  return {
    status,
    ease: Math.round(ease * 100) / 100,
    interval,
    reps,
    lapses,
    due: dueDay,
    last: when,
    history,
  };
}

function stampOnce(state, word) {
  const once = onceMap(state);
  const previous = once[word] || {};
  once[word] = {
    first: previous.first || todayISO(),
    last: todayISO(),
    hits: (Number(previous.hits) || 0) + 1,
  };
  return once[word];
}

function setOnceNails(state, word, nails) {
  const once = onceMap(state);
  const previous = once[word] || {};
  const next = parseHardMin(nails, DEFAULT_HARD_NAILS);
  once[word] = {
    first: previous.first || todayISO(),
    last: todayISO(),
    hits: Math.max(1, Number(previous.hits) || 1),
    nails: next,
  };
  return next;
}

function addToNotebook(state, word) {
  const book = notebookMap(state);
  const previous = book[word] || {};
  book[word] = {
    added: previous.added || todayISO(),
    last: todayISO(),
    hits: (Number(previous.hits) || 0) + 1,
  };
  stampOnce(state, word);
  setOnceNails(state, word, DEFAULT_HARD_NAILS);
  return book[word];
}

function gradeWord(word, grade) {
  if (!GRADES.has(grade)) throw new ApiError(`打分只能是：${[...GRADES].join(", ")}`);
  const { listId, key, card } = requireCard(word);
  const state = listState(listId);
  const updated = applyGrade(srsState(state, key), grade, todayISO());
  state.cards[key] = updated;
  if (NOTEBOOK_GRADES.has(grade)) addToNotebook(state, key);
  else if (LEARNED_GRADES.has(grade)) delete notebookMap(state)[key];
  appendLog(state, key, grade);
  writeProgress();
  return { word: key, grade, srs: updated, meaning: card.meaning, ...sessionContext(listId, state) };
}

function markLearned(word, grade = "learned") {
  const { listId, key } = requireCard(word);
  const state = listState(listId);
  state.cards[key] = learnedRecord(srsState(state, key), todayISO(), grade);
  delete notebookMap(state)[key];
  appendLog(state, key, grade);
  writeProgress();
  return { word: key, grade, srs: state.cards[key], ...sessionContext(listId, state) };
}

function markUnknown(word) {
  const { listId, key, card } = requireCard(word);
  const state = listState(listId);
  const updated = applyGrade(srsState(state, key), "unknown", todayISO());
  state.cards[key] = updated;
  const entry = addToNotebook(state, key);
  appendLog(state, key, "unknown");
  writeProgress();
  return { word: key, grade: "unknown", srs: updated, notebook: entry, meaning: card.meaning, ...sessionContext(listId, state) };
}

function dropNotebook(word) {
  const { listId, key } = requireCard(word);
  const state = listState(listId);
  state.cards[key] = learnedRecord(srsState(state, key), todayISO(), "drop-notebook");
  delete notebookMap(state)[key];
  if (!onceMap(state)[key]) setOnceNails(state, key, DEFAULT_HARD_NAILS);
  appendLog(state, key, "drop-notebook");
  writeProgress();
  return { word: key, grade: "drop-notebook", ...sessionContext(listId, state) };
}

function dropHard(word) {
  const { listId, key } = requireCard(word);
  const state = listState(listId);
  delete onceMap(state)[key];
  appendLog(state, key, "unhard");
  writeProgress();
  return { word: key, grade: "unhard", nails: 0, srs: srsState(state, key), ...sessionContext(listId, state) };
}

function setHardNails(word, nails) {
  const parsed = Number(nails);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) throw new ApiError("钉子必须是 1 到 3");
  const { listId, key } = requireCard(word);
  const state = listState(listId);
  const next = setOnceNails(state, key, parsed);
  const grade = `nails-${next}`;
  appendLog(state, key, grade);
  writeProgress();
  return { word: key, grade, nails: next, srs: srsState(state, key), ...sessionContext(listId, state) };
}

function peelStem(word) {
  const text = word.toLowerCase();
  for (const suffix of FAMILY_SUFFIXES) {
    if (text.endsWith(suffix) && text.length - suffix.length >= 4) return text.slice(0, -suffix.length);
  }
  return text;
}

function stemsMatch(left, right) {
  if (left === right) return true;
  if (left.length < 4 || right.length < 4) return false;
  return left + "e" === right || right + "e" === left;
}

function leftoverIsSuffix(base, chunk) {
  const extra = chunk.toLowerCase();
  if (STRONG_SET.has(extra)) return true;
  if (extra.startsWith("e") && STRONG_SET.has(extra.slice(1))) return true;
  return WEAK_SET.has(extra) && base.length >= 6;
}

function looksProper(card) {
  const surface = String(card.word || card.id || "");
  if (!surface) return false;
  const first = surface[0];
  const upper = first === first.toUpperCase() && first !== first.toLowerCase();
  const allUpper = surface === surface.toUpperCase() && surface !== surface.toLowerCase();
  return upper && !allUpper;
}

function isWeakInflection(base, other) {
  if (other.startsWith(base)) return WEAK_LEFTOVERS.has(other.slice(base.length));
  if (base.startsWith(other)) return WEAK_LEFTOVERS.has(base.slice(other.length));
  return false;
}

function splitPosGloss(meaning) {
  let rest = String(meaning || "").replace(/\s+/g, " ").trim();
  if (!rest) return ["", ""];
  let pos = "";
  const match = POS_HEAD.exec(rest);
  if (match) {
    pos = match[1].toLowerCase();
    rest = rest.slice(match[0].length).trim();
  }
  rest = rest.replace(/^\d+\.\s*/, "");
  rest = rest.split(/\s+\d+\.\s+/)[0];
  let gloss = rest.split(/[；;]/)[0].trim().replace(/^\d+\.\s*/, "").replace(/[，,、;； ]+$/g, "");
  if (gloss.length > 32) gloss = `${gloss.slice(0, 32).replace(/[，,、;； ]+$/g, "")}…`;
  return [pos, gloss];
}

function slimPhrases(phrases, limit = 3) {
  const seen = new Set();
  const out = [];
  for (const item of phrases || []) {
    const en = String(item.en || item.phrase || "").trim();
    const zh = String(item.zh || item.translation || "").trim();
    const key = en.toLowerCase();
    if (!en || seen.has(key)) continue;
    seen.add(key);
    out.push({ en, zh });
    if (out.length >= limit) break;
  }
  return out;
}

function familyEntry(card) {
  const [pos, gloss] = splitPosGloss(card.meaning || "");
  const usage = slimPhrases(card.phrases || [], 1);
  const entry = { word: card.word || card.id || "", pos, meaning: gloss };
  if (usage.length) entry.phrase = usage[0];
  return entry;
}

function relatedFamily(word, index) {
  const card = index[word];
  if (!card || looksProper(card) || word.length < 5) return [];
  const stem = peelStem(word);
  if (stem.length < 4) return [];
  const hits = [];
  const seen = new Set();
  for (const other of Object.keys(index)) {
    if (other === word || seen.has(other)) continue;
    if (!other.startsWith(word.slice(0, 4)) && !other.startsWith(stem.slice(0, 4))) continue;
    const otherCard = index[other];
    if (!otherCard || looksProper(otherCard)) continue;
    seen.add(other);
    if (other.startsWith(word) && leftoverIsSuffix(word, other.slice(word.length))) {
      hits.push(other);
      continue;
    }
    if (word.startsWith(other) && leftoverIsSuffix(other, word.slice(other.length))) {
      hits.push(other);
      continue;
    }
    const otherStem = peelStem(other);
    if (otherStem.length >= 4 && stemsMatch(stem, otherStem)) hits.push(other);
  }
  if (!hits.length || hits.every((item) => isWeakInflection(word, item))) return [];
  hits.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return hits.slice(0, 5).filter((item) => index[item]).map((item) => familyEntry(index[item]));
}

function bookPayload(kind) {
  if (kind !== "notebook" && kind !== "hard") throw new ApiError("kind 只能是 notebook 或 hard");
  const listId = activeId();
  const state = listState(listId);
  const meta = metaOf(listId);
  const index = indexCards(cardsOf(listId));
  const wanted = new Set(state.exams || []);
  const book = notebookMap(state);
  const once = onceMap(state);
  const ids =
    kind === "notebook"
      ? Object.keys(book).sort()
      : Object.keys(once)
          .filter((word) => isHardWord(state, word) && isLearned(srsState(state, word)))
          .sort();
  const rows = [];
  for (const word of ids) {
    const card = index[word];
    if (!card) continue;
    if (wanted.size && !(card.tags || []).some((tag) => wanted.has(tag))) continue;
    const extra = book[word] || once[word] || {};
    const item = {
      ...card,
      exams: examTagLabels(card, meta),
      family: relatedFamily(word, index),
      added: extra.added || extra.first || "",
      hits: Number(extra.hits) || 1,
    };
    if (kind === "hard") item.nails = nailsOf(once[word]);
    rows.push(item);
  }
  const payload = {
    kind,
    title: kind === "notebook" ? "生词本" : "难词本",
    total: rows.length,
    cards: rows,
    ...sessionContext(listId, state),
  };
  if (kind === "hard") {
    const levels = parseHardLevels(state.hard_levels || state.hard_min);
    const bands = { 1: 0, 2: 0, 3: 0 };
    for (const row of rows) bands[String(nailsOf(row))] += 1;
    payload.hard_levels = levels;
    payload.hard_bands = bands;
    payload.cards = rows.filter((row) => levels.includes(nailsOf(row)));
    payload.total = payload.cards.length;
    payload.hard_total = bands[1] + bands[2] + bands[3];
  }
  return payload;
}

function catalogPayload() {
  const rows = Object.entries(store.catalog.lists).map(([listId, meta]) => {
    const cards = store.cards.get(listId) || [];
    const state = store.progress.lists[listId] || {};
    const exams = normalizeExams({ ...blankState(meta), ...state }, meta);
    const subsets = Object.entries(meta.subsets || {}).map(([id, spec]) => ({
      id,
      label: (spec && spec.label) || id,
    }));
    return {
      id: listId,
      name: meta.name,
      level: meta.level,
      aliases: meta.aliases || [],
      file: meta.file,
      installed: cards.length > 0,
      total: cards.length,
      subset: state.subset || meta.default_subset || subsets[0]?.id || "all",
      subsets,
      exams,
      exam_options: examOptions(meta),
      subset_size: filteredCards(listId, exams).length,
      active: listId === (store.progress.active || store.catalog.active),
    };
  });
  return { active: store.progress.active || store.catalog.active, lists: rows };
}

function resolveList(query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return activeId();
  if (store.catalog.lists[needle]) return needle;
  for (const [listId, meta] of Object.entries(store.catalog.lists)) {
    const aliases = (meta.aliases || []).map((item) => String(item).toLowerCase());
    const names = [String(meta.name || "").toLowerCase(), String(meta.level || "").toLowerCase()];
    if (aliases.includes(needle) || names.includes(needle)) return listId;
  }
  throw new ApiError(`没有词表「${query}」`);
}

function useList(query) {
  const listId = resolveList(query);
  store.progress.active = listId;
  store.catalog.active = listId;
  const state = listState(listId);
  const meta = metaOf(listId);
  const needle = String(query || "").trim().toLowerCase();
  for (const [subsetId, spec] of Object.entries(meta.subsets || {})) {
    const labels = [subsetId.toLowerCase(), String((spec && spec.label) || "").toLowerCase()];
    if (labels.includes(needle)) {
      state.subset = subsetId;
      const tags = (spec && spec.any_tags) || [];
      const allowed = examIds(meta);
      state.exams = tags.length ? allowed.filter((exam) => tags.includes(exam)) : [...allowed];
      if (!state.exams.length) state.exams = [...allowed];
      break;
    }
  }
  writeProgress();
  return summarize(listId);
}

function applyExams(state, meta, exams) {
  const allowed = examIds(meta);
  const wanted = new Set(exams.map((exam) => String(exam).trim()));
  const cleaned = allowed.filter((exam) => wanted.has(exam));
  if (!cleaned.length) throw new ApiError("至少选一个范围");
  state.exams = cleaned;
  const subsets = meta.subsets || {};
  if (allowed.every((exam) => cleaned.includes(exam))) state.subset = subsets.all ? "all" : cleaned[0];
  else if (cleaned.length === 1) state.subset = cleaned[0];
  else state.subset = subsets.all ? "all" : cleaned[0];
  return cleaned;
}

function setOptions(body) {
  const listId = activeId();
  const state = listState(listId);
  const meta = metaOf(listId);
  if (body.hard_levels != null) {
    const levels = parseHardLevels(body.hard_levels);
    state.hard_levels = levels;
    state.hard_min = levels[0];
  } else if (body.hard_min != null) {
    const levels = parseHardLevels(parseHardMin(body.hard_min, 1));
    state.hard_levels = levels;
    state.hard_min = levels[0];
  } else if (Array.isArray(body.exams)) {
    applyExams(state, meta, body.exams);
  } else if (body.subset) {
    const spec = (meta.subsets || {})[body.subset];
    if (!spec) throw new ApiError(`没有子集 ${body.subset}`);
    state.subset = body.subset;
    const tags = spec.any_tags || [];
    const allowed = examIds(meta);
    state.exams = tags.length ? allowed.filter((exam) => tags.includes(exam)) : [...allowed];
    if (!state.exams.length) state.exams = [...allowed];
  } else {
    throw new ApiError("缺少 exams 或 subset");
  }
  writeProgress();
  return summarize(listId);
}

function slimPool() {
  const listId = activeId();
  const state = listState(listId);
  const cards = filteredCards(listId, state.exams)
    .filter((card) => card.meaning)
    .map((card) => ({ id: card.id, word: card.word || card.id, meaning: card.meaning || "" }));
  return { ...sessionContext(listId, state), total: cards.length, cards };
}

async function loadDeck(listId, meta) {
  const response = await fetch(new URL(meta.file, import.meta.url));
  if (!response.ok) throw new ApiError(`词表文件读不了：${meta.file}`, 404);
  const text = await response.text();
  const cards = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) cards.push(JSON.parse(trimmed));
  }
  store.cards.set(listId, cards);
}

export async function prepareLocal() {
  if (store.catalog) return;
  const response = await fetch(new URL("catalog.json", import.meta.url), { cache: "no-store" });
  if (!response.ok) throw new ApiError("词表目录读不了", 404);
  store.catalog = await response.json();
  store.progress = readProgress();
  if (!store.progress.active) store.progress.active = store.catalog.active || "";
  await Promise.all(Object.entries(store.catalog.lists).map(([listId, meta]) => loadDeck(listId, meta)));
}

export async function localApi(path, options = {}) {
  await prepareLocal();
  const url = new URL(path, "http://local");
  const method = String(options.method || "GET").toUpperCase();
  let body = {};
  if (options.body) {
    body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
  }
  const route = url.pathname.replace(/\/$/, "") || "/";
  const kind = url.searchParams.get("kind") || "notebook";
  const mode = url.searchParams.get("mode") || "quiz";
  const count = Number(url.searchParams.get("n") || "20");
  if (method === "GET" && route === "/api/status") return summarize();
  if (method === "GET" && route === "/api/lists") return catalogPayload();
  if (method === "GET" && route === "/api/next") {
    if (!["learn", "quiz", "review", "notebook", "hard", "once"].includes(mode)) {
      throw new ApiError("mode 只能是 quiz / notebook / hard");
    }
    if (!Number.isInteger(count) || count < 1 || count > 80) throw new ApiError("n 必须在 1 到 80 之间");
    return pickSession(mode, count);
  }
  if (method === "GET" && route === "/api/pool") return slimPool();
  if (method === "GET" && route === "/api/book") return bookPayload(kind);
  if (method === "POST" && route === "/api/grade") return gradeWord(body.word, String(body.grade || ""));
  if (method === "POST" && route === "/api/learned") return markLearned(body.word);
  if (method === "POST" && route === "/api/known") return markLearned(body.word, "known");
  if (method === "POST" && route === "/api/unknown") return markUnknown(body.word);
  if (method === "POST" && route === "/api/unhard") return dropHard(body.word);
  if (method === "POST" && route === "/api/nails") return setHardNails(body.word, body.nails);
  if (method === "POST" && route === "/api/drop-notebook") return dropNotebook(body.word);
  if (method === "POST" && route === "/api/use") return useList(body.list);
  if (method === "POST" && route === "/api/set") return setOptions(body);
  throw new ApiError("没有这个接口", 404);
}
