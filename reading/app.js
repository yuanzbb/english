document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
  if (!/reading\.css/.test(link.href)) link.remove();
});

const STORAGE_KEY = "language-reading-progress";
const PAYWALL = new Set([
  "The Atlantic",
  "The New Yorker",
  "The Economist",
  "Harper's Magazine",
  "National Geographic",
  "Scientific American",
]);

let progressCache = {};
let standalone = false;

async function loadProgress() {
  try {
    const response = await fetch("/api/reading");
    if (!response.ok) throw new Error("api");
    const data = await response.json();
    progressCache = data.progress && typeof data.progress === "object" ? data.progress : {};
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progressCache));
    standalone = false;
    return progressCache;
  } catch {
    standalone = true;
    try {
      progressCache = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      progressCache = {};
    }
    return progressCache;
  }
}

async function saveProgress(progress) {
  progressCache = progress;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  try {
    await fetch("/api/reading", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ progress }),
    });
  } catch {
    /* file API 还没开时，先留在本地 */
  }
}

function progressKey(weekId, articleId) {
  return `${weekId}:${articleId}`;
}

function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (!hash) return { name: "week" };
  if (hash === "archive") return { name: "archive" };
  if (hash === "all") return { name: "week", tag: "all" };
  const allJump = hash.match(/^all\/([^/]+)$/);
  if (allJump) return { name: "week", tag: "all", jump: allJump[1] };
  const old = hash.match(/^archive\/([^/]+)$/);
  if (old) return { name: "old", weekId: old[1] };
  const tagged = hash.match(/^tag\/([^/]+)(?:\/([^/]+))?$/);
  if (tagged) return { name: "week", tag: tagged[1], jump: tagged[2] };
  return { name: "week", jump: hash };
}

function firstTopic(week) {
  return (week.topics && week.topics[0]) || "";
}

function resolveTag(week, tag) {
  if (tag === "all") return "all";
  if (tag) return tag;
  return firstTopic(week);
}

function visibleArticles(week, tag) {
  if (tag === "all") return week.articles;
  return week.articles.filter((article) => article.topic === tag);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInline(text) {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, href) => {
      return `<button type="button" class="quiet" data-go="${escapeHtml(href)}">${escapeHtml(label)}</button>`;
    })
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function renderMarkdown(markdown) {
  return String(markdown)
    .trim()
    .split(/\n{2,}/)
    .map((block) => `<p>${renderInline(block.replaceAll("\n", " "))}</p>`)
    .join("");
}

function formatRange(start, end) {
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  return `${a.getMonth() + 1} 月 ${a.getDate()} 日 – ${b.getMonth() + 1} 月 ${b.getDate()} 日`;
}

function formatDate(iso) {
  if (iso.length === 10) {
    const day = new Date(`${iso}T00:00:00`);
    return `${day.getMonth() + 1} 月 ${day.getDate()} 日`;
  }
  const date = new Date(iso);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function siteNav(here) {
  return `<header class="masthead">
      <button type="button" class="brand" data-go="../">英语学习</button>
      <nav class="nav">
        <button type="button" class="${here === "reading" ? "on" : ""}" data-go="./index.html">阅读</button>
        <button type="button" class="${here === "vocab" ? "on" : ""}" data-go="../vocab/index.html">单词</button>
      </nav>
    </header>`;
}

function cover(article) {
  const topic = escapeHtml(article.topic || "");
  const credit = article.imageCredit
    ? `<p class="photo-credit">${escapeHtml(article.imageCredit)}</p>`
    : "";
  if (!article.image || !String(article.image).trim()) {
    return `<div class="cover-block"><div class="photo fallback topic-${topic}"><span>${topic}</span></div></div>`;
  }
  return `<div class="cover-block">
      <div class="photo topic-${topic}" data-topic="${topic}">
        <img src="${escapeHtml(article.image)}" alt="" onerror="this.parentElement.classList.add('is-broken')" />
      </div>
      ${credit}
    </div>`;
}

function articleHash(article, tag) {
  if (tag === "all") return `all/${article.id}`;
  if (tag) return `tag/${tag}/${article.id}`;
  return article.id;
}

function recordLabel(record) {
  if (record?.talked) return "已说";
  if (record?.read) return "已读";
  return "";
}

function talkPrompt(week, article) {
  const title = String(article.title || "").replaceAll("&", "and").replaceAll('"', "'");
  return `Discuss this article in English: ${week.id}:${article.id}, "${title}". Stay on this piece. English only. This is speaking and writing practice. Wait for me unless I ask you to walk me through or give me an opening.`;
}

function talkButton(key) {
  if (standalone) return "";
  return `<button type="button" class="btn" data-talk="${escapeHtml(key)}">回对话讨论</button>`;
}

function statusNote(record, key) {
  if (!record?.read && !record?.talked) {
    return "";
  }
  const when = record.talked ? record.talkedAt || record.readAt : record.readAt;
  const label = record.talked ? "已说于" : "已读于";
  return `${label} ${formatDate(when)}
    <button type="button" class="quiet" data-unread="${escapeHtml(key)}">标为未读</button>`;
}

function talkHref(text) {
  return `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(text)}`;
}

async function openTalk(href, text, cue) {
  if (standalone) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* 对话链优先；复制失败也不挡 */
  }
  let opened = false;
  try {
    const response = await fetch("/api/talk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    opened = response.ok;
  } catch {
    opened = false;
  }
  if (!opened && href) {
    window.location.assign(href);
  }
  if (cue) {
    cue.hidden = false;
    cue.textContent = opened
      ? "正在打开对话。若没跳过来，提示词已复制，回对话粘贴即可。"
      : "提示词已复制。回对话粘贴即可。";
  }
}

function toc(articles, tag, progress, weekId) {
  const showTopic = tag === "all";
  const items = articles
    .map((article, index) => {
      const record = progress[progressKey(weekId, article.id)];
      const label = recordLabel(record);
      const topic = showTopic ? `<span class="toc-topic">${escapeHtml(article.topic)}</span>` : "";
      return `
        <button type="button" class="toc-row" data-key="${escapeHtml(progressKey(weekId, article.id))}" data-hash="${escapeHtml(articleHash(article, tag))}">
          <span class="num">${String(index + 1).padStart(2, "0")}</span>
          <span class="toc-main">
            ${topic}
            <span class="toc-title">${escapeHtml(article.title)}</span>
            <span class="toc-dek">${escapeHtml(article.summary)}</span>
          </span>
          <span class="toc-state ${label ? "done" : ""}">${label}</span>
        </button>
      `;
    })
    .join("");
  return `<nav class="toc">${items}</nav>`;
}

function tagBar(week, currentTag) {
  const topics = week.topics || [];
  const rest = topics
    .map((topic) => {
      const active = currentTag === topic ? "on" : "";
      return `<button type="button" class="topic-chip ${active}" data-hash="tag/${encodeURIComponent(topic)}">${escapeHtml(topic)}</button>`;
    })
    .join("");
  const all = `<button type="button" class="topic-chip ${currentTag === "all" ? "on" : ""}" data-hash="all">全部</button>`;
  return `<nav class="tags">${rest}${all}</nav>`;
}

function piece(week, article, progress) {
  const key = progressKey(week.id, article.id);
  const record = progress[key];
  const prompt = talkPrompt(week, article);
  const wall = PAYWALL.has(article.source) ? " · 可能需订阅" : "";
  const status = statusNote(record, key);

  return `
    <article class="piece" id="${escapeHtml(article.id)}" data-key="${escapeHtml(key)}" data-talk-href="${escapeHtml(talkHref(prompt))}" data-talk-text="${escapeHtml(prompt)}">
      ${cover(article)}
      <div class="card-meta">
        <button type="button" class="tag" data-hash="tag/${encodeURIComponent(article.topic)}">${escapeHtml(article.topic)}</button>
        <span>${escapeHtml(article.source)} · ${formatDate(article.date)}</span>
        <span>导读约 ${article.briefingMinutes || article.minutes} 分钟</span>
        <span data-read-flag class="${record?.read || record?.talked ? "done" : ""}">${recordLabel(record) || "未读"}</span>
      </div>
      <h2>${escapeHtml(article.title)}</h2>
      <div class="prose">${renderMarkdown(article.briefing)}</div>
      <div class="piece-foot">
        <div class="actions">
          <button type="button" class="btn ghost" data-go="${escapeHtml(article.url)}" data-read-on-open="${escapeHtml(key)}">打开原文 · ${escapeHtml(article.source)}${wall}</button>
          <span data-talk-slot>${record?.read ? talkButton(key) : ""}</span>
        </div>
        <p class="piece-status" data-read-actions>${status}</p>
        <p class="talk-status" data-talk-status hidden></p>
      </div>
    </article>
  `;
}

function digestView(week, archive, progress, isCurrent, tag) {
  const visible = visibleArticles(week, tag);
  const tools = isCurrent
    ? `<button type="button" class="text-link" data-hash="archive">往期</button>`
    : `<button type="button" class="text-link" data-hash="">回本期</button>`;

  return `
    <div class="page">
      ${siteNav("reading")}
      <p class="kicker">
        <span>${escapeHtml(week.label)} · ${formatRange(week.start, week.end)}</span>
        <span class="kicker-tools">${tools}</span>
      </p>
      ${tagBar(week, tag)}
      ${toc(visible, tag, progress, week.id)}
      <div class="digest">
        ${visible.map((article) => piece(week, article, progress)).join("")}
      </div>
    </div>
  `;
}

function archiveView(archive) {
  const back = `
    <p class="kicker">
      <span>往期</span>
      <span class="kicker-tools"><button type="button" class="text-link" data-hash="">回本期</button></span>
    </p>`;
  const hint = standalone
    ? ""
    : `<p class="lead">要出新一期，在 Cursor 的对话窗口说「生成期刊」。</p>`;

  if (!archive.length) {
    return `
      <div class="page">
        ${siteNav("reading")}
        ${back}
        <h1>往期</h1>
        ${hint}
        <p class="lead">现在还没有往期。下一期出来时，这一期会整本移到这里。</p>
      </div>
    `;
  }

  const items = archive
    .map(
      (week) => `
        <button type="button" class="archive-item" data-hash="archive/${encodeURIComponent(week.id)}">
          <span>${escapeHtml(week.label)}</span>
          <strong>${escapeHtml(week.title)}</strong>
        </button>
      `
    )
    .join("");

  return `
    <div class="page">
      ${siteNav("reading")}
      ${back}
      <h1>往期</h1>
      ${hint}
      <div class="archive-list">${items}</div>
    </div>
  `;
}

async function loadJSON(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`无法读取 ${path}`);
  const data = await response.json();
  return data;
}

function updateReadCount() {
  const el = document.querySelector("[data-read-count]");
  if (!el) return;
  const keys = [...document.querySelectorAll(".piece[data-key]")].map((node) => node.dataset.key);
  const done = keys.filter((key) => progressCache[key]?.read).length;
  const label = el.textContent.includes("往期") ? "往期" : "本期";
  el.textContent = `${label} · 已读 ${done} / ${keys.length}`;
}

function paintRead(key, record) {
  document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`).forEach((node) => {
    const label = recordLabel(record);
    const state = node.querySelector(".toc-state");
    if (state) {
      state.textContent = label;
      state.classList.toggle("done", Boolean(label));
    }
    const flag = node.querySelector("[data-read-flag]");
    if (flag) {
      flag.textContent = label || "未读";
      flag.classList.toggle("done", Boolean(label));
    }
    const box = node.querySelector("[data-read-actions]");
    if (box) {
      box.innerHTML = statusNote(record, key);
    }
    const slot = node.querySelector("[data-talk-slot]");
    if (slot) {
      slot.innerHTML = record?.read ? talkButton(key) : "";
    }
    const flash = node.querySelector("[data-talk-status]");
    if (flash && !record?.read) {
      flash.hidden = true;
      flash.textContent = "";
    }
  });
  updateReadCount();
}

async function markRead(key) {
  if (!key || progressCache[key]?.read) return;
  const prev = progressCache[key] && typeof progressCache[key] === "object" ? progressCache[key] : {};
  progressCache[key] = {
    ...prev,
    read: true,
    readAt: prev.readAt || new Date().toISOString(),
  };
  await saveProgress(progressCache);
  paintRead(key, progressCache[key]);
}

async function markUnread(key) {
  if (!key) return;
  delete progressCache[key];
  await saveProgress(progressCache);
  paintRead(key, null);
}

function jumpTo(id) {
  const target = document.getElementById(id);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function render() {
  const app = document.querySelector("#app");
  const progress = await loadProgress();
  const current = route();

  try {
    const [week, archiveRaw] = await Promise.all([
      loadJSON("content/week.json"),
      loadJSON("content/archive.json"),
    ]);
    const archive = Array.isArray(archiveRaw) ? archiveRaw : [];

    if (current.name === "archive") {
      app.innerHTML = archiveView(archive);
      window.scrollTo(0, 0);
      return;
    }

    if (current.name === "old") {
      const oldWeek = await loadJSON(`content/archive/${current.weekId}.json`);
      app.innerHTML = digestView(oldWeek, archive, progress, false, resolveTag(oldWeek, current.tag));
      window.scrollTo(0, 0);
      return;
    }

    let tag = current.tag;
    if (!tag && current.jump) {
      const found = week.articles.find((item) => item.id === current.jump);
      if (found) tag = found.topic;
    }
    app.innerHTML = digestView(week, archive, progress, true, resolveTag(week, tag));
    if (current.jump) {
      requestAnimationFrame(() => jumpTo(current.jump));
    } else {
      window.scrollTo(0, 0);
    }
  } catch {
    app.innerHTML = `
      <div class="page">
        ${siteNav("reading")}
        <p class="lead">${standalone ? "这一期没有读出来。" : "阅读页打不开。"}</p>
        ${standalone ? "" : `<p class="note">在对话里说「开始学习」。</p>`}
      </div>
    `;
  }
}

function goHash(value) {
  const next = value ? `#${value}` : "#";
  if ((location.hash || "#") === next || (value === "" && !location.hash)) {
    history.replaceState(null, "", value ? `${location.pathname}${location.search}${next}` : `${location.pathname}${location.search}`);
    render();
    return;
  }
  location.hash = value;
}

document.addEventListener(
  "click",
  (event) => {
    const unread = event.target.closest("[data-unread]");
    if (unread) {
      event.preventDefault();
      markUnread(unread.dataset.unread);
      return;
    }
    const talk = event.target.closest("[data-talk]");
    if (talk) {
      event.preventDefault();
      event.stopPropagation();
      const key = talk.dataset.talk;
      const piece = talk.closest(".piece");
      if (!key || !piece || !progressCache[key]?.read) return;
      openTalk(piece.dataset.talkHref, piece.dataset.talkText, piece.querySelector("[data-talk-status]"));
      return;
    }
    const go = event.target.closest("[data-go]");
    if (go) {
      event.preventDefault();
      event.stopPropagation();
      const href = new URL(go.dataset.go, window.location.href).href;
      const key = go.dataset.readOnOpen;
      if (key) {
        markRead(key).finally(() => {
          window.location.assign(href);
        });
        return;
      }
      window.location.assign(href);
      return;
    }
    const hash = event.target.closest("[data-hash]");
    if (!hash) return;
    event.preventDefault();
    event.stopPropagation();
    goHash(hash.dataset.hash || "");
  },
  true
);

window.addEventListener("hashchange", render);
render();
