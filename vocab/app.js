import { localApi, prepareLocal } from "./engine.js?v=site1";

document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
  if (!/vocab\.css/.test(link.href)) link.remove();
});

const backend = (async () => {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    const type = response.headers.get("content-type") || "";
    if (response.ok && type.includes("json")) return "server";
  } catch {
    /* 静态站点没有本机接口 */
  }
  await prepareLocal();
  return "local";
})();

const SESSION_SIZE = 20;
const TYPES = ["en2zh", "zh2en", "cloze"];

const app = document.getElementById("app");
const state = {
  status: null,
  lists: [],
  pool: [],
  items: [],
  index: 0,
  locked: false,
  chosen: null,
  lastType: "",
  saving: false,
  correct: 0,
  wrong: 0,
  unknown: 0,
  marked: null,
  mode: "quiz",
  dropped: 0,
  detailOpen: false,
  bookKind: "",
  book: null,
  openWord: "",
  misses: [],
  hardLevels: [1, 2, 3],
  screen: "home",
  browseIndex: 0,
  browseOpen: false,
};

const NAIL_NAMES = { 1: "会了", 2: "半熟", 3: "生疏" };

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shuffle(list) {
  const items = [...list];
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

async function api(path, options = {}) {
  if ((await backend) === "local") return localApi(path, options);
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data.error || `请求失败 ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function serveHint() {
  return `<p class="lead">学习页还没醒来。</p>
    <p class="lead">回到 Cursor 对话里说「开始学习」，我帮你把这一页打开在旁边。</p>`;
}

function browseKind() {
  return (state.book && state.book.kind) || state.bookKind || "notebook";
}

function browseTitle() {
  return browseKind() === "hard" ? "浏览难词" : "浏览生词";
}

function backWhere() {
  if (state.screen === "browse") {
    return browseKind() === "hard" ? "难词本" : "生词本";
  }
  if (state.screen === "quiz" || state.screen === "done") {
    if (state.mode === "notebook") return "生词本";
    if (state.mode === "hard") return "难词本";
  }
  return "单词";
}

function renderBack() {
  return `<p class="back"><button type="button" data-act="back">${backWhere()}</button></p>`;
}

function goBack() {
  if (state.screen === "browse") {
    loadBook(browseKind());
    return;
  }
  if (state.screen === "quiz" || state.screen === "done") {
    if (state.mode === "notebook") {
      loadBook("notebook");
      return;
    }
    if (state.mode === "hard") {
      loadBook("hard");
      return;
    }
  }
  loadHome();
}

function layout(body) {
  document.body.classList.remove("browse-on");
  return `<div class="page">
    <header class="masthead">
      <button type="button" class="brand" data-go="../">英语学习</button>
      <nav class="nav">
        <button type="button" data-go="../reading/index.html">阅读</button>
        <button type="button" class="on" data-go="./index.html">单词</button>
      </nav>
    </header>
    ${body}
  </div>`;
}

function currentList() {
  return state.lists.find((item) => item.active) || state.lists[0];
}

function examOptions(active) {
  if (active && active.exam_options && active.exam_options.length) {
    return active.exam_options;
  }
  return ((active && active.subsets) || []).filter((item) => item.id !== "all");
}

function selectedExams(active) {
  const options = examOptions(active).map((item) => item.id);
  if (active && Array.isArray(active.exams) && active.exams.length) {
    return options.filter((id) => active.exams.includes(id));
  }
  if (state.status && Array.isArray(state.status.exams) && state.status.exams.length) {
    return options.filter((id) => state.status.exams.includes(id));
  }
  if (active && active.subset && active.subset !== "all") {
    return options.filter((id) => id === active.subset);
  }
  return options;
}

function renderPicker() {
  const installed = state.lists.filter((item) => item.installed);
  const active = currentList();
  const lists =
    installed.length > 1
      ? installed
          .map(
            (item) =>
              `<button type="button" class="chip${item.active ? " on" : ""}" data-list="${escapeHtml(item.id)}">${escapeHtml(item.name)}</button>`
          )
          .join("")
      : "";
  const selected = new Set(selectedExams(active));
  const exams = examOptions(active)
    .map((item) => {
      const on = selected.has(item.id);
      return `<button type="button" class="chip${on ? " on" : ""}" data-exam="${escapeHtml(item.id)}" aria-pressed="${on ? "true" : "false"}">${escapeHtml(item.label)}</button>`;
    })
    .join("");
  if (!lists && !exams) return "";
  return `<div class="picker">
      ${lists ? `<div class="chips">${lists}</div>` : ""}
      ${exams ? `<div class="chips">${exams}</div>` : ""}
    </div>`;
}

function progressCounts(status) {
  const progress = (status && status.progress) || {};
  return {
    learned: status.learned ?? progress.learned ?? 0,
    notebook: status.notebook ?? progress.notebook ?? 0,
    fresh: status.fresh ?? progress.fresh ?? 0,
    hard: status.hard ?? progress.hard ?? 0,
  };
}

function percent(part, whole) {
  if (!whole) return 0;
  return (part / whole) * 100;
}

function renderBarRow(row, max, extra = {}) {
  const total = row.total || 0;
  const learned = row.learned || 0;
  const notebook = row.notebook || 0;
  const fresh = row.fresh || 0;
  const hard = row.hard || 0;
  const on = extra.on ? " on" : "";
  const nameClass = extra.overall ? "bar-name overall" : "bar-name";
  const label = `${row.label}：已会 ${learned}，生词 ${notebook}，难词 ${hard}，还没学 ${fresh}，共 ${total}`;
  const meta = extra.overall
    ? `已会 ${learned} · 生词 ${notebook} · 难词 ${hard} · 还没学 ${fresh} · ${total}`
    : `已会 ${learned} · 生词 ${notebook} · 难词 ${hard} · ${total}`;
  return `<div class="bar-row${on}${extra.overall ? " overall" : ""}">
        <span class="${nameClass}">${escapeHtml(row.label)}</span>
        <div class="bar-track" role="img" aria-label="${escapeHtml(label)}">
          <div class="bar" style="width:${percent(total, max)}%">
            <span class="seg learned${learned ? "" : " empty"}" style="width:${percent(learned, total)}%"></span>
            <span class="seg hard${hard ? "" : " empty"}" style="width:${percent(hard, total)}%"></span>
            <span class="seg notebook${notebook ? "" : " empty"}" style="width:${percent(notebook, total)}%"></span>
            <span class="seg fresh${fresh ? "" : " empty"}" style="width:${percent(fresh, total)}%"></span>
          </div>
        </div>
        <span class="bar-meta">${meta}</span>
      </div>`;
}

function renderProgressChart(status) {
  const overall = status.overall_progress;
  const rows = status.exam_progress || [];
  if (!overall && !rows.length) return "";
  const selected = new Set(selectedExams(currentList()));
  const max = Math.max(overall ? overall.total || 0 : 0, ...rows.map((row) => row.total || 0), 1);
  const overallBar = overall
    ? renderBarRow({ ...overall, label: "总体" }, max, { on: true, overall: true })
    : "";
  const bars = rows
    .map((row) => renderBarRow(row, max, { on: !selected.size || selected.has(row.id) }))
    .join("");
  return `<p class="board-label">学习进度</p>
    <div class="chart">
      <div class="legend">
        <span><i class="swatch learned"></i>已会</span>
        <span><i class="swatch hard"></i>难词</span>
        <span><i class="swatch notebook"></i>生词</span>
        <span><i class="swatch fresh"></i>还没学</span>
      </div>
      <div class="bars">${overallBar}${bars}</div>
    </div>`;
}

function currentNails(card) {
  const nails = Number(card && card.nails);
  if (!Number.isFinite(nails) || nails < 1) return 3;
  return nails > 3 ? 3 : nails;
}

function nailName(count) {
  return NAIL_NAMES[count] || "";
}

function renderNailControl(card) {
  const current = currentNails(card);
  const word = card.id || card.word;
  return `<div class="nail-set tone-${current}" role="radiogroup" aria-label="松紧 ${nailName(current)}">
      ${[1, 2, 3]
        .map(
          (n) =>
            `<button type="button" class="nail lv${n}${n <= current ? " on" : ""}" data-act="nails" data-word="${escapeHtml(word)}" data-nails="${n}" aria-label="${nailName(n)}" aria-pressed="${n === current ? "true" : "false"}"></button>`
        )
        .join("")}
      <span class="nail-label">${nailName(current)}</span>
    </div>`;
}

function hardLevelsOf(source) {
  const raw = source && source.hard_levels;
  if (Array.isArray(raw) && raw.length) {
    const picked = [1, 2, 3].filter((n) => raw.map(Number).includes(n));
    if (picked.length) return picked;
  }
  return state.hardLevels && state.hardLevels.length ? state.hardLevels : [1, 2, 3];
}

function renderHardFilter(book) {
  const bands = book.hard_bands || {};
  const selected = new Set(hardLevelsOf(book));
  return `<div class="hard-filter">
      ${[3, 2, 1]
        .map((level) => {
          const on = selected.has(level);
          const count = bands[String(level)] ?? 0;
          return `<button type="button" class="hard-pick lv${level}${on ? " on" : ""}" data-act="hard-level" data-level="${level}" aria-pressed="${on ? "true" : "false"}">${nailName(level)} <span class="hard-pick-count">${count}</span></button>`;
        })
        .join("")}
    </div>`;
}

function renderBookExplain(card) {
  const detail = cardExplain(card);
  if (!detail.has) return `<p class="meta">这张词卡没有更多详解。</p>`;
  const phrases = detail.phrases
    .map(
      (item) =>
        `<li><span class="en">${escapeHtml(item.en || "")}</span>${
          item.zh ? `<span class="zh">${escapeHtml(item.zh)}</span>` : ""
        }</li>`
    )
    .join("");
  const family = cardFamily(card);
  return `<div class="explain">
      ${detail.ipa ? `<p class="ipa">/${escapeHtml(detail.ipa)}/</p>` : ""}
      ${detail.meaning ? `<p class="explain-meaning">${escapeHtml(detail.meaning)}</p>` : ""}
      ${detail.sentenceEn ? `<p class="explain-en">${escapeHtml(detail.sentenceEn)}</p>` : ""}
      ${detail.sentenceZh ? `<p class="explain-zh">${escapeHtml(detail.sentenceZh)}</p>` : ""}
      ${phrases ? `<ul class="explain-phrases">${phrases}</ul>` : ""}
      ${
        family.length
          ? `<p class="explain-family">${family
              .map((item) => {
                const word = familyLabel(item);
                const pos = item.pos ? ` ${item.pos}.` : "";
                const meaning = item.meaning ? ` ${item.meaning}` : "";
                return escapeHtml(`${word}${pos}${meaning}`.trim());
              })
              .join(" · ")}</p>`
          : ""
      }
    </div>`;
}

function renderBook() {
  const book = state.book;
  if (!book) return;
  const kind = book.kind;
  const hardTotal = book.hard_total ?? 0;
  const empty =
    kind === "notebook"
      ? "生词本是空的。"
      : hardTotal
        ? "没有选中的词。把生疏、半熟或会了再点上。"
        : "难词本是空的。";
  const reviewLabel = kind === "notebook" ? "复习生词" : "抽检难词";
  const cards = book.cards || [];
  const canQuiz = cards.length;
  const list = cards.length
    ? `<ul class="book-list">${cards
        .map((card) => {
          const open = state.openWord === card.id;
          const exams = (card.exams || []).join(" · ");
          return `<li class="book-item${open ? " open" : ""}">
            <div class="book-row">
              <button type="button" class="book-head" data-act="toggle-word" data-word="${escapeHtml(card.id)}">
                <strong>${escapeHtml(card.word || card.id)}</strong>
                <span class="meta">${escapeHtml(exams || "—")}</span>
              </button>
              ${kind === "hard" ? renderNailControl(card) : ""}
            </div>
            ${
              open
                ? `${renderBookExplain(card)}
                   ${
                     kind === "hard"
                       ? `<p class="book-forget">
                     <button type="button" class="forget" data-act="return-notebook" data-word="${escapeHtml(card.id)}">加回生词本</button>
                     <button type="button" class="forget" data-act="drop-book" data-word="${escapeHtml(card.id)}">移出难词本</button>
                   </p>`
                       : `<div class="actions">
                     <button type="button" class="btn ghost" data-act="drop-book" data-word="${escapeHtml(card.id)}">移出生词本</button>
                   </div>`
                   }`
                : ""
            }
          </li>`;
        })
        .join("")}</ul>`
    : `<p class="lead">${empty}</p>`;
  state.screen = "book";
  app.innerHTML = layout(`
    ${renderBack()}
    <p class="kicker">${escapeHtml(book.subset_label || "")}</p>
    <h1>${escapeHtml(book.title)}</h1>
    ${kind === "notebook" ? `<p class="lead">还不会的词。选对或移出后变成已会，并进入难词本。</p>` : ""}
    ${kind === "hard" ? renderHardFilter(book) : ""}
    <div class="actions">
      <button type="button" class="btn" data-act="browse" ${canQuiz ? "" : "disabled"}>${kind === "hard" ? "浏览难词" : "浏览生词"}</button>
      <button type="button" class="btn ghost" data-act="${kind === "notebook" ? "notebook" : "hard"}" ${canQuiz ? "" : "disabled"}>${reviewLabel}${canQuiz ? ` ${Math.min(SESSION_SIZE, cards.length)}` : ""}</button>
    </div>
    ${list}
  `);
}

function browseCards() {
  return (state.book && state.book.cards) || [];
}

function browseCard() {
  return browseCards()[state.browseIndex] || null;
}

function scoreIpa(text) {
  const raw = String(text || "").trim();
  if (!raw) return -1;
  let score = 0;
  if (/ɪ/.test(raw)) score += 4;
  if (/iː|i:/.test(raw)) score += 4;
  if (/[eɪaɪɔɪaʊəʊ]|eɪ|aɪ|ɔɪ|aʊ|əʊ/.test(raw)) score += 3;
  if (/[ˈˌ]/.test(raw)) score += 1;
  if (/ei|ai|oi|au|ou/.test(raw) && !/[ɪː]/.test(raw)) score -= 2;
  if (/i/.test(raw) && !/ɪ|iː|i:/.test(raw)) score -= 3;
  if (/ә/.test(raw)) score -= 1;
  return score;
}

function pickIpaSource(card) {
  const choices = [card && card.ipa, card && card.uk, card && card.us]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!choices.length) return "";
  return choices.slice().sort((a, b) => scoreIpa(b) - scoreIpa(a))[0];
}

function normalizeIpa(text) {
  let raw = String(text || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!raw) return "";
  raw = raw.replace(/ә/g, "ə").replace(/:/g, "ː").replace(/,/g, "ˌ").replace(/'/g, "ˈ");
  raw = raw
    .replace(/eɪ/g, "\u0001")
    .replace(/aɪ/g, "\u0002")
    .replace(/ɔɪ/g, "\u0003")
    .replace(/aʊ/g, "\u0004")
    .replace(/əʊ|oʊ|əu|ou/g, "\u0005")
    .replace(/ɪə|iə/g, "\u0006")
    .replace(/eə|ɛə/g, "\u0007")
    .replace(/ʊə|uə/g, "\u0008")
    .replace(/ei/g, "\u0001")
    .replace(/ai/g, "\u0002")
    .replace(/oi/g, "\u0003")
    .replace(/au/g, "\u0004");
  raw = raw.replace(/aː/g, "ɑː").replace(/i(?!ː)/g, "ɪ");
  return raw
    .replace(/\u0001/g, "eɪ")
    .replace(/\u0002/g, "aɪ")
    .replace(/\u0003/g, "ɔɪ")
    .replace(/\u0004/g, "aʊ")
    .replace(/\u0005/g, "əʊ")
    .replace(/\u0006/g, "ɪə")
    .replace(/\u0007/g, "eə")
    .replace(/\u0008/g, "ʊə");
}

function cardIpa(card) {
  return normalizeIpa(pickIpaSource(card));
}

function cardSentence(card) {
  const sentence = (card && card.sentence) || {};
  return String(sentence.en || "").trim();
}

function cardSentenceZh(card) {
  const sentence = (card && card.sentence) || {};
  return String(sentence.zh || "").trim();
}

function renderFlashRow(en, zh, pos) {
  const left = [];
  if (en) left.push(escapeHtml(en));
  if (pos) left.push(`<em>${escapeHtml(pos)}.</em>`);
  const right = zh ? `<span class="flash-zh">${escapeHtml(zh)}</span>` : "";
  if (!left.length && !right) return "";
  return `<span class="flash-line">${left.join(" ")}${right ? ` ${right}` : ""}</span>`;
}

function renderFlashExample(card) {
  return renderFlashRow(cardSentence(card), cardSentenceZh(card));
}

const EXAM_MARKS = {
  cet4: "4级",
  cet6: "6级",
  ielts: "雅思",
  toefl: "托福",
  四级: "4级",
  六级: "6级",
  雅思: "雅思",
  托福: "托福",
};

function cardExamMarks(card) {
  const raw = (card && card.exams) || [];
  const marks = [];
  const seen = new Set();
  for (const item of raw) {
    const mark = EXAM_MARKS[item] || item;
    if (!mark || seen.has(mark)) continue;
    seen.add(mark);
    marks.push(mark);
  }
  return marks.join(" · ");
}

function cardPhrases(card) {
  return (Array.isArray(card && card.phrases) ? card.phrases : [])
    .filter((item) => item && (item.en || item.zh))
    .slice(0, 3);
}

function cardFamily(card) {
  return (Array.isArray(card && card.family) ? card.family : [])
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") return { word: item, pos: "", meaning: "" };
      const word = item.word || item.id;
      return word ? item : null;
    })
    .filter(Boolean)
    .slice(0, 5);
}

function familyLabel(item) {
  if (typeof item === "string") return item;
  return item.word || item.id || "";
}

function renderFlashMore(card) {
  const phrases = cardPhrases(card);
  const family = cardFamily(card);
  const phraseBlock = phrases.length
    ? `<span class="flash-extra"><span class="flash-k">搭配</span>${phrases
        .map((item) => renderFlashRow(item.en, item.zh))
        .join("")}</span>`
    : "";
  const familyBlock = family.length
    ? `<span class="flash-extra"><span class="flash-k">变形</span>${family
        .map((item) => {
          const phrase = item.phrase || {};
          return `${renderFlashRow(item.word || item.id, item.meaning, item.pos)}${renderFlashRow(
            phrase.en,
            phrase.zh
          )}`;
        })
        .join("")}</span>`
    : "";
  return `${phraseBlock}${familyBlock}`;
}

function renderBrowse() {
  document.body.classList.add("browse-on");
  const cards = browseCards();
  const card = browseCard();
  state.screen = "browse";
  if (!card) {
    app.innerHTML = `<div class="browse-page">
      <button type="button" class="browse-back" data-act="back">返回</button>
      <p class="browse-empty">${browseKind() === "hard" ? "难词本是空的。" : "生词本是空的。"}</p>
    </div>`;
    return;
  }
  const ipa = cardIpa(card);
  const open = state.browseOpen;
  const last = Math.max(0, cards.length - 1);
  app.innerHTML = `<div class="browse-page" data-act="browse-next" tabindex="0">
    <button type="button" class="browse-back" data-act="back">返回</button>
    <p class="browse-count">${state.browseIndex + 1} / ${cards.length}</p>
    <div class="flash${open ? " open" : ""}">
      <span class="flash-word">${escapeHtml(card.word || card.id)}</span>
      <span class="flash-ipa">${ipa ? `/${escapeHtml(ipa)}/` : ""}</span>
      <span class="flash-exams">${escapeHtml(cardExamMarks(card))}</span>
      <span class="flash-reveal">
        <span class="flash-meaning">${escapeHtml(card.meaning || "（暂无释义）")}</span>
        <span class="flash-example">${renderFlashExample(card)}</span>
        <span class="flash-more">${renderFlashMore(card)}</span>
      </span>
      <span class="flash-tools">
        ${
          browseKind() === "hard"
            ? renderNailControl(card)
            : `<button type="button" class="flash-known" data-act="browse-known">会了</button>`
        }
      </span>
    </div>
    <div class="browse-seek-wrap" data-act="browse-seek">
      <input type="range" class="browse-seek" min="0" max="${last}" step="1" value="${state.browseIndex}" tabindex="-1" />
    </div>
  </div>`;
  bindBrowseSeek();
  paintSeekFill(app.querySelector(".browse-seek"));
  const page = app.querySelector(".browse-page");
  if (page) page.focus({ preventScroll: true });
}

function fillBrowseCard() {
  const cards = browseCards();
  const card = browseCard();
  const root = app.querySelector(".browse-page");
  if (!root || !card) return;
  const ipa = cardIpa(card);
  const count = root.querySelector(".browse-count");
  if (count) count.textContent = `${state.browseIndex + 1} / ${cards.length}`;
  const word = root.querySelector(".flash-word");
  if (word) word.textContent = card.word || card.id;
  const ipaEl = root.querySelector(".flash-ipa");
  if (ipaEl) ipaEl.textContent = ipa ? `/${ipa}/` : "";
  const examsEl = root.querySelector(".flash-exams");
  if (examsEl) examsEl.textContent = cardExamMarks(card);
  const meaning = root.querySelector(".flash-meaning");
  if (meaning) meaning.textContent = card.meaning || "（暂无释义）";
  const exampleEl = root.querySelector(".flash-example");
  if (exampleEl) exampleEl.innerHTML = renderFlashExample(card);
  const more = root.querySelector(".flash-more");
  if (more) more.innerHTML = renderFlashMore(card);
  const flash = root.querySelector(".flash");
  if (flash) flash.classList.toggle("open", state.browseOpen);
  const tools = root.querySelector(".flash-tools");
  if (tools) {
    tools.innerHTML =
      browseKind() === "hard"
        ? renderNailControl(card)
        : `<button type="button" class="flash-known" data-act="browse-known">会了</button>`;
  }
  const slider = root.querySelector(".browse-seek");
  if (slider) {
    slider.max = String(Math.max(0, cards.length - 1));
    if (Number(slider.value) !== state.browseIndex) slider.value = String(state.browseIndex);
    paintSeekFill(slider);
  }
}

function paintSeekFill(slider) {
  if (!slider) return;
  const max = Number(slider.max) || 0;
  const pct = max <= 0 ? 0 : (Number(slider.value) / max) * 100;
  slider.style.setProperty("--seek", `${pct}%`);
}

function seekBrowse(index) {
  const cards = browseCards();
  if (!cards.length) return;
  const next = Math.max(0, Math.min(cards.length - 1, Number(index)));
  if (next === state.browseIndex && !state.browseOpen) {
    fillBrowseCard();
    return;
  }
  state.browseIndex = next;
  state.browseOpen = false;
  fillBrowseCard();
}

function bindBrowseSeek() {
  const slider = app.querySelector(".browse-seek");
  if (!slider) return;
  const stop = (event) => event.stopPropagation();
  slider.addEventListener("pointerdown", stop);
  slider.addEventListener("mousedown", stop);
  slider.addEventListener("click", stop);
  slider.addEventListener("input", (event) => {
    event.stopPropagation();
    seekBrowse(event.target.value);
  });
}

function showBrowse(index) {
  const cards = browseCards();
  if (!cards.length) {
    state.browseIndex = 0;
    state.browseOpen = false;
    renderBrowse();
    return;
  }
  state.browseIndex = Math.max(0, Math.min(cards.length - 1, index));
  state.browseOpen = false;
  renderBrowse();
}

function browseForward() {
  if (!browseCard()) return;
  if (!state.browseOpen) {
    state.browseOpen = true;
    renderBrowse();
    return;
  }
  if (state.browseIndex >= browseCards().length - 1) return;
  showBrowse(state.browseIndex + 1);
}

function browseBack() {
  if (!browseCard()) return;
  if (state.browseOpen) {
    state.browseOpen = false;
    renderBrowse();
    return;
  }
  if (state.browseIndex <= 0) return;
  showBrowse(state.browseIndex - 1);
}

function nudgeBrowseNails(delta) {
  const card = browseCard();
  if (!card || browseKind() !== "hard") return;
  const next = currentNails(card) + delta;
  if (next < 1 || next > 3) return;
  setNails(card.id, next);
}

async function knowBrowseCard() {
  const card = browseCard();
  if (!card || browseKind() !== "notebook") return;
  const keepIndex = state.browseIndex;
  try {
    await api("/api/drop-notebook", {
      method: "POST",
      body: JSON.stringify({ word: card.id }),
    });
    const [book, status] = await Promise.all([
      api("/api/book?kind=notebook"),
      api("/api/status"),
    ]);
    state.book = book;
    state.status = status;
    state.browseOpen = false;
    state.browseIndex = Math.min(keepIndex, Math.max(0, browseCards().length - 1));
    renderBrowse();
  } catch (error) {
    renderError(error);
  }
}

async function startBrowse(kind) {
  const wanted = kind === "hard" ? "hard" : "notebook";
  state.bookKind = wanted;
  renderBoot(wanted === "hard" ? "正在打开难词…" : "正在打开生词…");
  try {
    state.book = await api(`/api/book?kind=${wanted}`);
    if (wanted === "hard") state.hardLevels = hardLevelsOf(state.book);
    state.browseIndex = 0;
    state.browseOpen = false;
    renderBrowse();
  } catch (error) {
    renderError(error);
  }
}

async function loadBook(kind) {
  state.bookKind = kind;
  renderBoot(kind === "hard" ? "正在打开难词本…" : "正在打开生词本…");
  try {
    state.book = await api(`/api/book?kind=${kind}`);
    if (kind === "hard") state.hardLevels = hardLevelsOf(state.book);
    state.openWord = "";
    renderBook();
  } catch (error) {
    renderError(error);
  }
}

async function dropFromBook(word) {
  const kind = state.bookKind;
  try {
    if (kind === "hard") {
      await api("/api/unhard", {
        method: "POST",
        body: JSON.stringify({ word }),
      });
    } else {
      await api("/api/drop-notebook", {
        method: "POST",
        body: JSON.stringify({ word }),
      });
    }
    const [book, status] = await Promise.all([api(`/api/book?kind=${kind}`), api("/api/status")]);
    state.book = book;
    state.status = status;
    if (state.openWord === word) state.openWord = "";
    renderBook();
  } catch (error) {
    renderError(error);
  }
}

async function returnToNotebook(word) {
  try {
    await api("/api/unknown", {
      method: "POST",
      body: JSON.stringify({ word }),
    });
    const [book, status] = await Promise.all([api("/api/book?kind=hard"), api("/api/status")]);
    state.book = book;
    state.status = status;
    if (state.openWord === word) state.openWord = "";
    renderBook();
  } catch (error) {
    renderError(error);
  }
}

function renderHome() {
  const status = state.status;
  const counts = progressCounts(status);
  const startLabel = counts.fresh ? `学新词 ${Math.min(SESSION_SIZE, counts.fresh)} 题` : "新词都已会";
  state.screen = "home";
  app.innerHTML = layout(`
    <h1>${escapeHtml(status.name)}</h1>
    ${renderPicker()}
    ${renderProgressChart(status)}
    <div class="actions equal">
      <button type="button" class="btn ghost" data-act="start" ${counts.fresh ? "" : "disabled"}>${startLabel}</button>
      <button type="button" class="btn ghost" data-act="open-book" data-book="notebook">生词本 ${counts.notebook}</button>
      <button type="button" class="btn ghost" data-act="open-book" data-book="hard">难词本 ${counts.hard}</button>
    </div>
    <p class="hint">* 选对记为已会。<br />* 答错或不熟进入生词本。<br />* 学会后可抽检难词。<br />* 抽检选对后点三个点，改生疏、半熟或会了。</p>
  `);
}

function clozeText(card) {
  const sentence = card.sentence && card.sentence.en;
  if (!sentence) return "";
  const pattern = new RegExp(`\\b${escapeRe(card.word)}[a-z]*\\b`, "i");
  if (!pattern.test(sentence)) return "";
  return sentence.replace(pattern, "______");
}

function pickType(card) {
  const usable = TYPES.filter((type) => type !== "cloze" || clozeText(card));
  const rotated = usable.filter((type) => type !== state.lastType);
  return (rotated[0] || usable[0] || "en2zh");
}

function pickDistractors(card, field) {
  const seen = new Set([card.id, card[field]]);
  const options = [];
  for (const item of shuffle(state.pool)) {
    if (item.id === card.id || !item[field] || seen.has(item[field])) continue;
    seen.add(item[field]);
    options.push(item);
    if (options.length === 3) break;
  }
  return options;
}

function buildQuestion(card) {
  const type = pickType(card);
  state.lastType = type;
  if (type === "en2zh") {
    const choices = shuffle([
      { id: card.id, text: card.meaning, correct: true },
      ...pickDistractors(card, "meaning").map((item) => ({
        id: item.id,
        text: item.meaning,
        correct: false,
      })),
    ]);
    return {
      type,
      card,
      prompt: card.word,
      ipa: cardIpa(card),
      choices,
    };
  }
  const cloze = type === "cloze" ? clozeText(card) : "";
  const choices = shuffle([
    { id: card.id, text: card.word, correct: true },
    ...pickDistractors(card, "word").map((item) => ({
      id: item.id,
      text: item.word,
      correct: false,
    })),
  ]);
  return {
    type,
    card,
    prompt: cloze || card.meaning,
    ipa: "",
    choices,
  };
}

function currentQuestion() {
  return state.items[state.index];
}

function typeLabel(type) {
  if (type === "en2zh") return "英 → 中";
  if (type === "zh2en") return "中 → 英";
  return "挖空";
}

function modeKicker(mode) {
  if (mode === "notebook") return " · 生词本";
  if (mode === "hard") return " · 抽检";
  return "";
}

function cardExamLabels(card) {
  if (card && Array.isArray(card.exams) && card.exams.length) {
    return card.exams;
  }
  const tags = new Set((card && card.tags) || []);
  return examOptions(currentList())
    .filter((item) => tags.has(item.id))
    .map((item) => item.label);
}

function renderExamTag(card) {
  const labels = cardExamLabels(card);
  if (!labels.length) return "";
  return `<p class="exam-tag">${escapeHtml(labels.join(" · "))}</p>`;
}

function cardExplain(card) {
  const ipa = cardIpa(card);
  const sentence = card.sentence || {};
  const phrases = (Array.isArray(card.phrases) ? card.phrases : [])
    .filter((item) => item && (item.en || item.zh))
    .slice(0, 2);
  return {
    ipa,
    meaning: card.meaning || "",
    sentenceEn: sentence.en || "",
    sentenceZh: sentence.zh || "",
    phrases,
    has: Boolean(ipa || card.meaning || sentence.en || sentence.zh || phrases.length),
  };
}

function canExplain() {
  const item = currentQuestion();
  if (!item || !state.locked) return false;
  return cardExplain(item.card).has;
}

function renderExplain(card) {
  if (!state.detailOpen || !canExplain()) return "";
  const detail = cardExplain(card);
  const phrases = detail.phrases
    .map(
      (item) =>
        `<li><span class="en">${escapeHtml(item.en || "")}</span>${
          item.zh ? `<span class="zh">${escapeHtml(item.zh)}</span>` : ""
        }</li>`
    )
    .join("");
  return `<div class="explain">
      <p class="explain-word">${escapeHtml(card.word)}${
        detail.ipa ? ` <span class="ipa">/${escapeHtml(detail.ipa)}/</span>` : ""
      }</p>
      ${detail.meaning ? `<p class="explain-meaning">${escapeHtml(detail.meaning)}</p>` : ""}
      ${detail.sentenceEn ? `<p class="explain-en">${escapeHtml(detail.sentenceEn)}</p>` : ""}
      ${detail.sentenceZh ? `<p class="explain-zh">${escapeHtml(detail.sentenceZh)}</p>` : ""}
      ${phrases ? `<ul class="explain-phrases">${phrases}</ul>` : ""}
    </div>`;
}

function renderQuiz() {
  const item = currentQuestion();
  const total = state.items.length;
  const at = state.index + 1;
  const promptClass = item.type === "en2zh" ? "word" : item.type === "cloze" ? "cloze" : "meaning";
  const choices = item.choices
    .map((choice, index) => {
      let klass = "choice";
      if (state.locked) {
        if (choice.correct) klass += " correct";
        else if (state.chosen === index) klass += " wrong";
      }
      return `<button type="button" class="${klass}" data-choice="${index}">
        <span class="num">${index + 1}</span>
        <span class="text">${escapeHtml(choice.text)}</span>
      </button>`;
    })
    .join("");
  let feedback = "";
  if (state.locked && state.marked === "unknown") {
    feedback =
      state.mode === "hard"
        ? `<p class="feedback">已加回生词本。先看一眼再继续。</p>
         <p class="reveal">${escapeHtml(item.card.word)} · ${escapeHtml(item.card.meaning)}</p>`
        : `<p class="feedback">还不熟，先看一眼。已加入生词本。</p>
         <p class="reveal">${escapeHtml(item.card.word)} · ${escapeHtml(item.card.meaning)}</p>`;
  } else if (state.locked && state.chosen !== null) {
    const ok = item.choices[state.chosen].correct;
    feedback = ok
      ? `<p class="feedback ok">对</p>`
      : `<p class="feedback bad">错了。看一眼再继续。</p>
         <p class="reveal">${escapeHtml(item.card.word)} · ${escapeHtml(item.card.meaning)}</p>`;
  }
  const waitNext = needsManualNext();
  state.screen = "quiz";
  app.innerHTML = layout(`
    ${renderBack()}
    <div class="progress">
      <span>${at} / ${total}</span>
      <div class="bar"><span style="width:${(state.index / total) * 100}%"></span></div>
      <span>${escapeHtml(typeLabel(item.type))}</span>
    </div>
    <p class="kicker">${escapeHtml(state.status.name)} · ${escapeHtml(state.status.subset_label || "")}${modeKicker(state.mode)}</p>
    <div class="prompt">
      <p class="${promptClass}">${escapeHtml(item.prompt)}</p>
      ${renderExamTag(item.card)}
      ${item.ipa ? `<p class="ipa">/${escapeHtml(item.ipa)}/</p>` : ""}
    </div>
    ${state.mode === "hard" ? `<div class="nail-after">${renderNailControl(item.card)}</div>` : ""}
    <div class="choices">${choices}</div>
    ${feedback}
    ${renderExplain(item.card)}
    <div class="actions">
      ${
        waitNext
          ? `<button type="button" class="btn" data-act="next">下一题</button>${
              canExplain()
                ? `<button type="button" class="btn ghost" data-act="detail">${state.detailOpen ? "收起" : "看详解"}</button>`
                : ""
            }`
          : state.locked
            ? ""
            : state.mode === "hard"
              ? `<button type="button" class="btn note" data-act="unknown">加回生词本 · U</button>`
              : `<button type="button" class="btn note" data-act="unknown">还不熟 · U</button>`
      }
    </div>
    ${quizRuleHint()}
  `);
}

function quizRuleHint() {
  if (state.mode === "hard") {
    return `<p class="hint under-actions">三个点随时可以改档：生疏、半熟、会了。</p>`;
  }
  if (state.mode === "notebook") {
    return `<p class="hint under-actions">选对后变成已会，并进入难词本。</p>`;
  }
  return "";
}

function renderDone() {
  const answered = state.correct + state.wrong;
  const rate = answered ? Math.round((state.correct / answered) * 100) : 0;
  const misses = state.misses.length
    ? `<ul class="wrong-list">${state.misses
        .map(
          (card) => `<li><strong>${escapeHtml(card.word)}</strong><span class="meta">${escapeHtml(card.meaning)}</span></li>`
        )
        .join("")}</ul>`
    : `<p class="lead">这轮没有错词。</p>`;
  state.screen = "done";
  app.innerHTML = layout(`
    ${renderBack()}
    <p class="kicker">本轮结束</p>
    <h1>对 ${state.correct} · 错 ${state.wrong}</h1>
    <p class="score">${rate}%</p>
    <p class="lead">这轮已会 ${state.correct} 个，生词记下 ${state.misses.length} 个。</p>
    ${misses}
    <div class="actions">
      <button type="button" class="btn" data-act="again">再来一轮</button>
      <button type="button" class="btn ghost" data-act="back">回${backWhere()}</button>
    </div>
  `);
}

function renderBoot(message) {
  app.innerHTML = layout(`<p class="lead">${escapeHtml(message)}</p>`);
}

function renderError(error) {
  const generic =
    !error.message || error.message.includes("Failed to fetch") || error.message.includes("请求失败");
  app.innerHTML = layout(generic ? serveHint() : `<p class="error">${escapeHtml(error.message)}</p>`);
}

async function loadHome() {
  renderBoot("正在读取词表…");
  try {
    const [status, catalog] = await Promise.all([api("/api/status"), api("/api/lists")]);
    state.status = status;
    state.lists = catalog.lists || [];
    state.hardLevels = hardLevelsOf(status);
    renderHome();
  } catch (error) {
    renderError(error);
  }
}

async function switchList(listId) {
  renderBoot("正在换词表…");
  try {
    state.status = await api("/api/use", {
      method: "POST",
      body: JSON.stringify({ list: listId }),
    });
    const catalog = await api("/api/lists");
    state.lists = catalog.lists || [];
    renderHome();
  } catch (error) {
    renderError(error);
  }
}

async function toggleExam(examId) {
  const active = currentList();
  const options = examOptions(active).map((item) => item.id);
  const current = selectedExams(active);
  let exams = current.includes(examId)
    ? current.filter((id) => id !== examId)
    : [...current, examId];
  exams = options.filter((id) => exams.includes(id));
  if (!exams.length) return;
  renderBoot("正在换范围…");
  try {
    state.status = await api("/api/set", {
      method: "POST",
      body: JSON.stringify({ exams }),
    });
    const catalog = await api("/api/lists");
    state.lists = catalog.lists || [];
    renderHome();
  } catch (error) {
    renderError(error);
  }
}

async function startSession(mode = "quiz") {
  state.mode = mode === "notebook" || mode === "hard" ? mode : "quiz";
  const boot =
    state.mode === "notebook" ? "正在抽出生词…" : state.mode === "hard" ? "正在抽检难词…" : "正在抽题…";
  renderBoot(boot);
  try {
    const [next, pool] = await Promise.all([
      api(`/api/next?mode=${state.mode}&n=${SESSION_SIZE}`),
      api("/api/pool"),
    ]);
    state.status = {
      ...state.status,
      name: next.name,
      subset: next.subset,
      subset_label: next.subset_label,
      exams: next.exams,
    };
    state.pool = pool.cards || [];
    state.lastType = "";
    state.items = (next.cards || []).map(buildQuestion).filter((item) => item.choices.length >= 2);
    state.index = 0;
    state.locked = false;
    state.chosen = null;
    state.correct = 0;
    state.wrong = 0;
    state.unknown = 0;
    state.dropped = 0;
    state.marked = null;
    state.detailOpen = false;
    state.misses = [];
    if (!state.items.length) {
      const empty =
        state.mode === "notebook"
          ? "生词本是空的。回单词去学新词。"
          : state.mode === "hard"
            ? "这一层没有可抽的难词。回难词本换一层，或先把生词学会。"
            : "这一范围的新词都已会了。可以去复习生词。";
      state.screen = "done";
      app.innerHTML = layout(`${renderBack()}
        <p class="lead">${empty}</p>
        <div class="actions"><button type="button" class="btn" data-act="back">回${backWhere()}</button></div>`);
      return;
    }
    renderQuiz();
  } catch (error) {
    renderError(error);
  }
}

function finishIfDone() {
  if (state.index >= state.items.length) {
    renderDone();
    return true;
  }
  state.locked = false;
  state.chosen = null;
  state.marked = null;
  state.detailOpen = false;
  renderQuiz();
  return false;
}

function needsManualNext() {
  const item = currentQuestion();
  if (!item || !state.locked) return false;
  if (state.marked === "unknown") return true;
  if (state.chosen === null) return false;
  if (!item.choices[state.chosen].correct) return true;
  return state.mode === "notebook" || state.mode === "hard";
}

function advance() {
  state.index += 1;
  finishIfDone();
}

async function choose(index) {
  const item = currentQuestion();
  if (!item) return;
  if (state.locked) {
    if (!state.saving && needsManualNext()) {
      advance();
    }
    return;
  }
  const choice = item.choices[index];
  if (!choice) return;
  state.locked = true;
  state.saving = true;
  state.chosen = index;
  const ok = choice.correct;
  if (ok) state.correct += 1;
  else {
    state.wrong += 1;
    state.misses.push(item.card);
  }
  renderQuiz();
  try {
    if (ok) {
      await api("/api/learned", {
        method: "POST",
        body: JSON.stringify({ word: item.card.id }),
      });
    } else {
      await api("/api/grade", {
        method: "POST",
        body: JSON.stringify({ word: item.card.id, grade: "again" }),
      });
    }
  } catch (error) {
    state.saving = false;
    renderError(error);
    return;
  }
  state.saving = false;
  if (ok && !needsManualNext()) {
    window.setTimeout(advance, 350);
  }
}

async function setNails(word, nails) {
  const value = Number(nails);
  try {
    await api("/api/nails", {
      method: "POST",
      body: JSON.stringify({ word, nails: value }),
    });
  } catch (error) {
    renderError(error);
    return;
  }
  if (state.mode === "hard" && currentQuestion() && currentQuestion().card.id === word) {
    const item = currentQuestion();
    item.card.nails = value;
    renderQuiz();
    return;
  }
  if (state.screen === "browse" && browseKind() === "hard") {
    const keepIndex = state.browseIndex;
    const keepOpen = state.browseOpen;
    await refreshHardBook(word, value, false);
    const next = browseCards().findIndex((item) => item.id === word);
    if (next >= 0) {
      state.browseIndex = next;
      state.browseOpen = keepOpen;
    } else {
      state.browseIndex = Math.min(keepIndex, Math.max(0, browseCards().length - 1));
      state.browseOpen = false;
    }
    renderBrowse();
    return;
  }
  if (state.bookKind === "hard" && state.book) {
    await refreshHardBook(word, value, true);
  }
}

async function refreshHardBook(word, nails, drawBook = true) {
  const [book, status] = await Promise.all([api("/api/book?kind=hard"), api("/api/status")]);
  state.book = book;
  state.status = status;
  state.hardLevels = hardLevelsOf(book);
  const visible = state.hardLevels.includes(Number(nails));
  if (!visible && state.openWord === word) state.openWord = "";
  if (drawBook) renderBook();
}

async function toggleHardLevel(level) {
  const value = Number(level);
  if (![1, 2, 3].includes(value)) return;
  const current = hardLevelsOf(state.book);
  let next = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value].sort((a, b) => a - b);
  if (!next.length) return;
  if (next.length === current.length && next.every((item, i) => item === current[i])) return;
  try {
    await api("/api/set", {
      method: "POST",
      body: JSON.stringify({ hard_levels: next }),
    });
    state.hardLevels = next;
    const [book, status] = await Promise.all([api("/api/book?kind=hard"), api("/api/status")]);
    state.book = book;
    state.status = status;
    state.openWord = "";
    renderBook();
  } catch (error) {
    renderError(error);
  }
}

async function markUnknown() {
  const item = currentQuestion();
  if (!item || state.locked) return;
  state.locked = true;
  state.chosen = null;
  state.marked = "unknown";
  try {
    await api("/api/unknown", {
      method: "POST",
      body: JSON.stringify({ word: item.card.id }),
    });
  } catch (error) {
    renderError(error);
    return;
  }
  state.unknown += 1;
  state.misses.push(item.card);
  renderQuiz();
}

document.addEventListener(
  "click",
  (event) => {
    const go = event.target.closest("[data-go]");
    if (!go) return;
    event.preventDefault();
    event.stopPropagation();
    window.location.assign(new URL(go.dataset.go, window.location.href).href);
  },
  true
);

app.addEventListener("click", (event) => {
  const list = event.target.closest("[data-list]");
  if (list) {
    switchList(list.dataset.list);
    return;
  }
  const exam = event.target.closest("[data-exam]");
  if (exam) {
    toggleExam(exam.dataset.exam);
    return;
  }
  const back = event.target.closest("[data-act=back]");
  if (back) {
    goBack();
    return;
  }
  const home = event.target.closest("[data-act=home]");
  if (home) {
    loadHome();
    return;
  }
  const openBook = event.target.closest("[data-act=open-book]");
  if (openBook) {
    loadBook(openBook.dataset.book);
    return;
  }
  const browse = event.target.closest("[data-act=browse]");
  if (browse) {
    startBrowse(state.bookKind || (state.book && state.book.kind) || "notebook");
    return;
  }
  const browseSeek = event.target.closest("[data-act=browse-seek]");
  if (browseSeek) {
    return;
  }
  const browseKnown = event.target.closest("[data-act=browse-known]");
  if (browseKnown) {
    knowBrowseCard();
    return;
  }
  const nailsOnCard = event.target.closest("[data-act=nails]");
  if (nailsOnCard) {
    setNails(nailsOnCard.dataset.word, nailsOnCard.dataset.nails);
    return;
  }
  const browseNext = event.target.closest("[data-act=browse-next]");
  if (browseNext) {
    browseForward();
    return;
  }
  const toggleWord = event.target.closest("[data-act=toggle-word]");
  if (toggleWord) {
    const word = toggleWord.dataset.word;
    state.openWord = state.openWord === word ? "" : word;
    renderBook();
    return;
  }
  const dropBook = event.target.closest("[data-act=drop-book]");
  if (dropBook) {
    dropFromBook(dropBook.dataset.word);
    return;
  }
  const returnNotebook = event.target.closest("[data-act=return-notebook]");
  if (returnNotebook) {
    returnToNotebook(returnNotebook.dataset.word);
    return;
  }
  const hardLevel = event.target.closest("[data-act=hard-level]");
  if (hardLevel) {
    toggleHardLevel(hardLevel.dataset.level);
    return;
  }
  const nails = event.target.closest("[data-act=nails]");
  if (nails) {
    setNails(nails.dataset.word, nails.dataset.nails);
    return;
  }
  const notebook = event.target.closest("[data-act=notebook]");
  if (notebook) {
    startSession("notebook");
    return;
  }
  const hard = event.target.closest("[data-act=hard]");
  if (hard) {
    startSession("hard");
    return;
  }
  const start = event.target.closest("[data-act=start]");
  if (start) {
    startSession("quiz");
    return;
  }
  const again = event.target.closest("[data-act=again]");
  if (again) {
    startSession(state.mode || "quiz");
    return;
  }
  const detail = event.target.closest("[data-act=detail]");
  if (detail) {
    if (!canExplain()) return;
    state.detailOpen = !state.detailOpen;
    renderQuiz();
    return;
  }
  const next = event.target.closest("[data-act=next]");
  if (next) {
    advance();
    return;
  }
  const unknown = event.target.closest("[data-act=unknown]");
  if (unknown) {
    markUnknown();
    return;
  }
  const choice = event.target.closest("[data-choice]");
  if (choice) {
    choose(Number(choice.dataset.choice));
  }
});

window.addEventListener(
  "keydown",
  (event) => {
    if (state.screen !== "browse") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const forward = event.key === "ArrowRight" || event.key === "PageDown" || event.key === " " || event.key === "Enter";
    const back = event.key === "ArrowLeft" || event.key === "PageUp";
    const nail = Number(event.key);
    if (browseKind() === "hard" && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      event.stopPropagation();
      nudgeBrowseNails(event.key === "ArrowUp" ? 1 : -1);
      return;
    }
    if (browseKind() === "hard" && nail >= 1 && nail <= 3 && browseCard()) {
      event.preventDefault();
      event.stopPropagation();
      setNails(browseCard().id, nail);
      return;
    }
    if (!forward && !back && event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      goBack();
      return;
    }
    if (forward) browseForward();
    else browseBack();
  },
  true
);

window.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (state.screen === "browse") return;
  if (event.key === "Escape" && state.screen && state.screen !== "home") {
    event.preventDefault();
    goBack();
    return;
  }
  if (event.key === "u" || event.key === "U") {
    event.preventDefault();
    markUnknown();
    return;
  }
  if (event.key === "d" || event.key === "D") {
    if (canExplain()) {
      event.preventDefault();
      state.detailOpen = !state.detailOpen;
      renderQuiz();
    }
    return;
  }
  if (event.key === " " || event.key === "Enter") {
    if (needsManualNext()) {
      event.preventDefault();
      advance();
    }
    return;
  }
  const number = Number(event.key);
  if (number >= 1 && number <= 3 && canSetQuizNails()) {
    event.preventDefault();
    setNails(currentQuestion().card.id, number);
    return;
  }
  if (number >= 1 && number <= 4) {
    event.preventDefault();
    choose(number - 1);
  }
});

function canSetQuizNails() {
  return Boolean(currentQuestion() && state.mode === "hard" && state.locked);
}

loadHome();
