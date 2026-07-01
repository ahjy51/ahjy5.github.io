import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = process.cwd();
const blogDir = path.join(rootDir, 'src/pages/blog');
const postsPath = path.join(rootDir, 'src/data/posts.ts');
const dynamicPostPath = path.join(blogDir, '[...slug].astro');
const port = Number(process.env.BLOG_ADMIN_PORT || 4322);
const publishPaths = ['src/data/posts.ts', 'src/pages/blog'];

const textTypes = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function runGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: rootDir,
      timeout: options.timeout || 120_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (error) {
        error.output = output;
        reject(error);
        return;
      }
      resolve(output);
    });
  });
}

async function hasStagedChanges(paths = []) {
  try {
    await runGit(['diff', '--cached', '--quiet', '--', ...paths]);
    return false;
  } catch (error) {
    if (error?.code === 1) return true;
    throw error;
  }
}

async function publishPosts(res) {
  const branch = (await runGit(['branch', '--show-current'])).trim();
  if (branch !== 'master') {
    sendJson(res, 409, { error: `当前分支是 ${branch || '未知'}，请切换到 master 后再推送。` });
    return;
  }

  const beforeStatus = await runGit(['status', '--short', '--', ...publishPaths]);
  const log = [];
  let committed = false;

  if (beforeStatus) {
    await runGit(['add', '--', ...publishPaths]);
    if (await hasStagedChanges(publishPaths)) {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const commitOutput = await runGit(['commit', '-m', `Update blog posts ${stamp}`, '--', ...publishPaths]);
      committed = true;
      log.push(commitOutput);
    }
  }

  const pushOutput = await runGit(['push', 'origin', 'master'], { timeout: 180_000 });
  if (pushOutput) log.push(pushOutput);

  sendJson(res, 200, {
    ok: true,
    committed,
    message: committed ? '已提交并推送到 GitHub。' : '没有新的文章改动，已同步远端状态。',
    output: log.filter(Boolean).join('\n\n'),
  });
}

function getString(source, key) {
  const single = new RegExp(`${key}:\\s*'((?:\\\\'|[^'])*)'`).exec(source);
  if (single) return single[1].replace(/\\'/g, "'");

  const double = new RegExp(`${key}:\\s*"((?:\\\\"|[^"])*)"`).exec(source);
  if (double) return double[1].replace(/\\"/g, '"');

  return '';
}

function getTags(source) {
  const match = /tags:\s*\[([\s\S]*?)\]/.exec(source);
  if (!match) return [];
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((tag) => tag[1].trim()).filter(Boolean);
}

function getBoolean(source, key) {
  const match = new RegExp(`${key}:\\s*(true|false)`).exec(source);
  return match ? match[1] === 'true' : false;
}

async function readPosts() {
  const source = await readFile(postsPath, 'utf8');
  const postsBlock = /export const posts: Post\[] = \[([\s\S]*?)\];/.exec(source);
  if (!postsBlock) return [];

  return [...postsBlock[1].matchAll(/\{\s*([\s\S]*?)\s*\},/g)].map((match) => {
    const entry = match[1];
    return {
      slug: getString(entry, 'slug'),
      title: getString(entry, 'title'),
      description: getString(entry, 'description'),
      date: getString(entry, 'date'),
      tags: getTags(entry),
      hidden: getBoolean(entry, 'hidden'),
    };
  }).filter((post) => post.slug);
}

async function writePosts(posts) {
  const orderedPosts = [...posts].sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  const entries = orderedPosts.map((post) => `  {
    slug: ${JSON.stringify(post.slug)},
    title: ${JSON.stringify(post.title)},
    description: ${JSON.stringify(post.description)},
    date: ${JSON.stringify(post.date)},
    tags: ${JSON.stringify(post.tags)},
    hidden: ${Boolean(post.hidden)},
  },`).join('\n');

  const source = `export interface Post {
  slug: string;
  title: string;
  description: string;
  date: string;
  tags: string[];
  hidden: boolean;
}

export const posts: Post[] = [
${entries}
];

export function getSortedPosts(): Post[] {
  return posts.filter((post) => !post.hidden).sort((a, b) => b.date.localeCompare(a.date));
}
`;

  await writeFile(postsPath, source, 'utf8');
}

function postFile(slug) {
  return path.join(blogDir, `${slug}.astro`);
}

function isManagedPost(slug) {
  return existsSync(postFile(slug));
}

function sanitizeSlug(slug) {
  return String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractConst(source, name) {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*(['"\`])([\\s\\S]*?)\\1\\s*;`).exec(source);
  return match ? match[2] : '';
}

function extractTagsConst(source) {
  const match = /const\s+tags\s*=\s*(\[[\s\S]*?\])\s*;/.exec(source);
  if (!match) return [];
  try {
    return JSON.parse(match[1].replace(/'/g, '"'));
  } catch {
    return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((tag) => tag[1]);
  }
}

function extractContent(source) {
  const match = /<div class="prose">\s*([\s\S]*?)\s*<\/div>\s*<\/div>\s*<\/article>/m.exec(source);
  return match ? match[1].trim() : '<p></p>';
}

async function readManagedPost(slug) {
  const source = await readFile(postFile(slug), 'utf8');
  return {
    title: extractConst(source, 'title'),
    description: extractConst(source, 'description'),
    date: extractConst(source, 'date'),
    tags: extractTagsConst(source),
    content: extractContent(source),
  };
}

async function readDynamicPost(slug) {
  const posts = await readPosts();
  const meta = posts.find((post) => post.slug === slug);
  const source = await readFile(dynamicPostPath, 'utf8');

  return {
    title: meta?.title || '',
    description: meta?.description || '',
    date: meta?.date || '',
    tags: meta?.tags || [],
    content: extractContent(source),
  };
}

async function removeDynamicSlug(slug) {
  if (!existsSync(dynamicPostPath)) return;

  const source = await readFile(dynamicPostPath, 'utf8');
  const nextSource = source.replace(
    new RegExp(`\\n\\s*\\{\\s*params:\\s*\\{\\s*slug:\\s*['"]${slug}['"]\\s*\\}\\s*\\},?`, 'g'),
    '',
  );

  if (nextSource !== source) {
    await writeFile(dynamicPostPath, nextSource, 'utf8');
  }
}

function renderPost({ title, description, date, tags, content }) {
  return `---
import Layout from '../../layouts/Layout.astro';

const title = ${JSON.stringify(title)};
const description = ${JSON.stringify(description)};
const date = ${JSON.stringify(date)};
const tags = ${JSON.stringify(tags)};
---

<Layout title={\`\${title} — Iscream\`} description={description}>
  <article class="max-w-3xl mx-auto px-4 pt-24 pb-16">
    <a href="/blog" class="inline-flex items-center gap-1 text-sm text-hyouka-gold dark:text-amber-400 
                          hover:text-hyouka-sakura dark:hover:text-pink-300 transition-colors mb-6">
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
      </svg>
      返回文章列表
    </a>

    <header class="mb-8">
      <div class="flex items-center gap-2 mb-3 flex-wrap">
        {tags.map(tag => <span class="hyouka-tag">{tag}</span>)}
      </div>
      <h1 class="hyouka-heading text-2xl md:text-3xl mb-4">
        {title}
      </h1>
      <div class="flex items-center gap-3 text-sm text-hyouka-mist dark:text-gray-500">
        <time datetime={date}>{date}</time>
        <span>·</span>
        <span>Iscream</span>
      </div>
    </header>

    <div class="hyouka-card p-6 md:p-8">
      <div class="prose">
${content.trim().split('\n').map((line) => `        ${line}`).join('\n')}
      </div>
    </div>
  </article>
</Layout>
`;
}

async function listPosts(res) {
  const posts = await readPosts();
  sendJson(res, 200, {
    posts: posts.map((post) => ({
      ...post,
      managed: isManagedPost(post.slug),
      editable: true,
    })),
  });
}

async function getPost(res, searchParams) {
  const slug = sanitizeSlug(searchParams.get('slug'));
  if (!slug) {
    sendJson(res, 404, { error: '文章不存在。' });
    return;
  }

  const posts = await readPosts();
  const meta = posts.find((post) => post.slug === slug);
  if (!meta) {
    sendJson(res, 404, { error: '文章不存在。' });
    return;
  }

  const managed = isManagedPost(slug);
  const post = managed ? await readManagedPost(slug) : await readDynamicPost(slug);
  sendJson(res, 200, { post: { ...meta, ...post, slug, managed } });
}

async function savePost(res, body) {
  const oldSlug = sanitizeSlug(body.oldSlug);
  const slug = sanitizeSlug(body.slug);
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const date = String(body.date || '').trim();
  const tags = Array.isArray(body.tags)
    ? body.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : String(body.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
  const content = String(body.content || '').trim() || '<p></p>';

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    sendJson(res, 400, { error: 'Slug 只能包含小写英文、数字和短横线。' });
    return;
  }

  if (!title || !description || !date) {
    sendJson(res, 400, { error: '标题、摘要和日期不能为空。' });
    return;
  }

  const posts = await readPosts();
  const existing = posts.find((post) => post.slug === slug);
  const isRename = oldSlug && oldSlug !== slug;
  const previousPost = posts.find((post) => post.slug === (oldSlug || slug));
  const hidden = typeof body.hidden === 'boolean' ? body.hidden : previousPost?.hidden || existing?.hidden || false;

  if (!oldSlug && existing && !isManagedPost(slug)) {
    sendJson(res, 409, { error: '这个 slug 已存在，但不是独立文章文件，不能覆盖。' });
    return;
  }

  if (isRename && existing) {
    sendJson(res, 409, { error: '新的 slug 已被使用。' });
    return;
  }

  await mkdir(blogDir, { recursive: true });

  if (isRename && isManagedPost(oldSlug)) {
    await rename(postFile(oldSlug), postFile(slug));
  }

  await writeFile(postFile(slug), renderPost({ title, description, date, tags, content }), 'utf8');
  await removeDynamicSlug(oldSlug || slug);

  const nextPosts = posts.filter((post) => post.slug !== oldSlug && post.slug !== slug);
  nextPosts.push({ slug, title, description, date, tags, hidden });
  await writePosts(nextPosts);

  sendJson(res, 200, { ok: true, slug, hidden });
}

async function setPostVisibility(res, body) {
  const slug = sanitizeSlug(body.slug);
  if (!slug) {
    sendJson(res, 400, { error: '缺少要显示或隐藏的文章 slug。' });
    return;
  }

  if (typeof body.hidden !== 'boolean') {
    sendJson(res, 400, { error: '缺少显示/隐藏状态。' });
    return;
  }

  const posts = await readPosts();
  const post = posts.find((item) => item.slug === slug);
  if (!post) {
    sendJson(res, 404, { error: '文章不存在。' });
    return;
  }

  post.hidden = body.hidden;
  await writePosts(posts);
  sendJson(res, 200, { ok: true, slug, hidden: post.hidden });
}

async function deletePost(res, body) {
  const slug = sanitizeSlug(body.slug);
  if (!slug) {
    sendJson(res, 400, { error: '缺少要删除的文章 slug。' });
    return;
  }

  const posts = await readPosts();
  const nextPosts = posts.filter((post) => post.slug !== slug);
  if (nextPosts.length === posts.length) {
    sendJson(res, 404, { error: '文章不存在。' });
    return;
  }

  if (isManagedPost(slug)) {
    await unlink(postFile(slug));
  }

  await removeDynamicSlug(slug);
  await writePosts(nextPosts);

  sendJson(res, 200, { ok: true });
}

const appHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Blog Admin</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f2ec;
        --panel: #fffaf5;
        --line: #ded4ca;
        --text: #2c1810;
        --muted: #7c6b5f;
        --accent: #d47aa3;
        --accent-strong: #b95584;
        --green: #3a5a40;
        --shadow: 0 14px 40px rgba(44, 24, 16, 0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Noto Sans SC", sans-serif;
        background: var(--bg);
        color: var(--text);
      }
      .app {
        display: grid;
        grid-template-columns: 300px minmax(0, 1fr);
        min-height: 100vh;
      }
      aside {
        border-right: 1px solid var(--line);
        background: rgba(255, 250, 245, 0.76);
        padding: 22px;
        position: sticky;
        top: 0;
        height: 100vh;
        overflow: auto;
      }
      main { padding: 26px; }
      h1, h2 { margin: 0; font-family: Georgia, "Noto Serif SC", serif; }
      h1 { font-size: 22px; }
      h2 { font-size: 20px; }
      .muted { color: var(--muted); font-size: 13px; }
      .topbar, .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        box-shadow: var(--shadow);
      }
      .topbar {
        padding: 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
      }
      .card { padding: 18px; }
      .post-list { display: grid; gap: 10px; margin-top: 18px; }
      .post-item {
        width: 100%;
        text-align: left;
        border: 1px solid var(--line);
        background: #fff;
        border-radius: 8px;
        padding: 11px 12px;
        color: var(--text);
        cursor: pointer;
        display: grid;
        gap: 5px;
        min-height: 64px;
        align-content: center;
      }
      .post-item.active { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(212, 122, 163, .14); }
      .post-item-hidden { opacity: .72; }
      .post-title {
        display: block;
        font-weight: 700;
        line-height: 1.35;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .post-meta {
        color: var(--muted);
        display: block;
        font-size: 12px;
        font-weight: 650;
        line-height: 1.35;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .badge {
        display: inline-flex;
        width: max-content;
        border-radius: 999px;
        padding: 2px 8px;
        border: 1px solid rgba(212, 122, 163, .3);
        color: var(--accent-strong);
        font-size: 12px;
        line-height: 1.3;
      }
      .badge-muted {
        border-color: rgba(124, 107, 95, .32);
        color: var(--muted);
      }
      button {
        border: 1px solid var(--line);
        background: #fff;
        color: var(--text);
        border-radius: 8px;
        height: 38px;
        padding: 0 12px;
        cursor: pointer;
        font-weight: 650;
      }
      button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
      button.primary:hover { background: var(--accent-strong); }
      button.warning { color: #8a4b00; border-color: #e6c48d; background: #fff8e8; }
      button.warning:hover { background: #fff0cf; }
      button.danger { color: #b42318; border-color: #e7b8b1; background: #fff7f5; }
      button.danger:hover { background: #ffe7e2; }
      button.icon { width: 38px; padding: 0; }
      button:disabled { opacity: .5; cursor: not-allowed; }
      form {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      label { display: grid; gap: 7px; font-size: 13px; color: var(--muted); }
      input, textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
        color: var(--text);
        min-height: 40px;
        padding: 9px 11px;
        font: inherit;
      }
      .full { grid-column: 1 / -1; }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        border: 1px solid var(--line);
        border-bottom: 0;
        border-radius: 8px 8px 0 0;
        background: #fff;
        padding: 10px;
      }
      .editor {
        min-height: 430px;
        border: 1px solid var(--line);
        border-radius: 0 0 8px 8px;
        background: #fff;
        padding: 20px;
        line-height: 1.8;
        outline: none;
        overflow: auto;
      }
      .editor h2 { margin-top: 1.3em; border-bottom: 1px solid var(--line); padding-bottom: .25em; }
      .editor blockquote { border-left: 4px solid var(--accent); margin-left: 0; padding-left: 14px; color: var(--muted); }
      .editor pre { background: #1f2937; color: #f9fafb; padding: 14px; border-radius: 8px; overflow: auto; }
      .source {
        min-height: 430px;
        border-radius: 0 0 8px 8px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        line-height: 1.6;
      }
      .hidden { display: none; }
      .status { min-height: 20px; font-size: 13px; color: var(--green); }
      .error { color: #b42318; }
      .actions { display: flex; align-items: center; gap: 10px; justify-content: flex-end; }
      .publish-log {
        background: #2c1810;
        border-radius: 8px;
        color: #fffaf5;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        line-height: 1.55;
        margin: -8px 0 18px;
        max-height: 180px;
        overflow: auto;
        padding: 12px;
        white-space: pre-wrap;
      }
      @media (max-width: 860px) {
        .app { grid-template-columns: 1fr; }
        aside { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
        form { grid-template-columns: 1fr; }
        main { padding: 16px; }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <aside>
        <h1>Blog Admin</h1>
        <p class="muted">管理 Astro 博客文章。旧动态文章也可编辑，保存时会迁移为独立文章。</p>
        <button id="newPost" class="primary" style="width:100%; margin-top:14px;">新建文章</button>
        <div id="postList" class="post-list"></div>
      </aside>
      <main>
        <div class="topbar">
          <div>
            <h2 id="formTitle">新建文章</h2>
            <div class="muted">保存后会写入 <code>src/pages/blog</code> 和 <code>src/data/posts.ts</code></div>
          </div>
          <div class="actions">
            <span id="status" class="status"></span>
            <button id="publishPosts" type="button">推送到 GitHub</button>
            <button id="toggleVisibility" class="warning" disabled>隐藏文章</button>
            <button id="deletePost" class="danger" disabled>删除文章</button>
            <button id="savePost" class="primary">保存</button>
          </div>
        </div>
        <pre id="publishLog" class="publish-log hidden"></pre>
        <div class="card">
          <form id="postForm">
            <label>
              Slug（URL 路径）
              <input id="slug" required placeholder="my-new-post" />
              <span class="muted">例：my-new-post 会生成 /blog/my-new-post/</span>
            </label>
            <label>
              日期
              <input id="date" type="date" required />
            </label>
            <label class="full">
              标题
              <input id="title" required placeholder="文章标题" />
            </label>
            <label class="full">
              摘要
              <textarea id="description" required rows="2" placeholder="文章摘要"></textarea>
            </label>
            <label class="full">
              标签，逗号分隔
              <input id="tags" placeholder="技术, 前端" />
            </label>
            <div class="full">
              <div class="toolbar">
                <button type="button" class="icon" data-cmd="bold" title="加粗"><b>B</b></button>
                <button type="button" class="icon" data-cmd="italic" title="斜体"><i>I</i></button>
                <button type="button" data-block="h2">H2</button>
                <button type="button" data-block="h3">H3</button>
                <button type="button" data-block="p">正文</button>
                <button type="button" data-cmd="insertUnorderedList">列表</button>
                <button type="button" data-action="quote">引用</button>
                <button type="button" data-action="code">代码块</button>
                <button type="button" data-action="link">链接</button>
                <button type="button" data-action="image">图片</button>
                <button type="button" id="toggleSource">源码</button>
              </div>
              <div id="editor" class="editor" contenteditable="true"></div>
              <textarea id="source" class="source hidden"></textarea>
            </div>
          </form>
        </div>
      </main>
    </div>
    <script>
      const postList = document.querySelector('#postList');
      const editor = document.querySelector('#editor');
      const source = document.querySelector('#source');
      const statusEl = document.querySelector('#status');
      const deleteButton = document.querySelector('#deletePost');
      const visibilityButton = document.querySelector('#toggleVisibility');
      const publishButton = document.querySelector('#publishPosts');
      const publishLog = document.querySelector('#publishLog');
      const fields = {
        slug: document.querySelector('#slug'),
        date: document.querySelector('#date'),
        title: document.querySelector('#title'),
        description: document.querySelector('#description'),
        tags: document.querySelector('#tags'),
      };

      let posts = [];
      let oldSlug = '';
      let sourceMode = false;
      let currentHidden = false;

      function today() {
        return new Date().toISOString().slice(0, 10);
      }

      function setStatus(message, isError = false) {
        statusEl.textContent = message;
        statusEl.classList.toggle('error', isError);
      }

      function setPublishLog(message = '') {
        publishLog.textContent = message;
        publishLog.classList.toggle('hidden', !message);
      }

      function splitTags(value) {
        return value.split(',').map((tag) => tag.trim()).filter(Boolean);
      }

      function updateVisibilityButton() {
        visibilityButton.disabled = !oldSlug;
        visibilityButton.textContent = currentHidden ? '显示文章' : '隐藏文章';
      }

      function setForm(post = null) {
        oldSlug = post?.slug || '';
        currentHidden = Boolean(post?.hidden);
        fields.slug.value = post?.slug || '';
        fields.date.value = post?.date || today();
        fields.title.value = post?.title || '';
        fields.description.value = post?.description || '';
        fields.tags.value = (post?.tags || []).join(', ');
        editor.innerHTML = post?.content || '<p>开始写作……</p>';
        source.value = editor.innerHTML;
        document.querySelector('#formTitle').textContent = post ? '编辑文章' : '新建文章';
        deleteButton.disabled = !post?.slug;
        updateVisibilityButton();
        setStatus('');
        renderList();
      }

      function renderList() {
        postList.innerHTML = posts.map((post) => \`
          <button class="post-item \${post.slug === oldSlug ? 'active' : ''} \${post.hidden ? 'post-item-hidden' : ''}" data-slug="\${post.slug}">
            <span class="post-title">\${post.title}</span>
            <span class="post-meta">\${post.date} · /\${post.slug}</span>
            \${post.hidden ? '<span class="badge badge-muted">已隐藏</span>' : ''}
            \${post.managed ? '' : '<span class="badge">旧文章，保存后迁移</span>'}
          </button>
        \`).join('');
      }

      async function loadPosts() {
        const response = await fetch('/api/posts');
        const data = await response.json();
        posts = data.posts || [];
        renderList();
      }

      async function loadPost(slug) {
        const response = await fetch('/api/post?slug=' + encodeURIComponent(slug));
        const data = await response.json();
        if (!response.ok) {
          setStatus(data.error || '加载失败', true);
          return;
        }
        setForm(data.post);
      }

      function syncSourceFromEditor() {
        source.value = editor.innerHTML.trim();
      }

      function syncEditorFromSource() {
        editor.innerHTML = source.value.trim() || '<p></p>';
      }

      document.querySelector('#newPost').addEventListener('click', () => setForm());

      postList.addEventListener('click', (event) => {
        const item = event.target.closest('.post-item');
        if (!item) return;
        loadPost(item.dataset.slug);
      });

      document.querySelector('.toolbar').addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        if (sourceMode && button.id !== 'toggleSource') return;

        editor.focus();
        if (button.dataset.cmd) document.execCommand(button.dataset.cmd, false, null);
        if (button.dataset.block) document.execCommand('formatBlock', false, button.dataset.block);
        if (button.dataset.action === 'quote') document.execCommand('formatBlock', false, 'blockquote');
        if (button.dataset.action === 'code') document.execCommand('insertHTML', false, '<pre><code>code</code></pre>');
        if (button.dataset.action === 'link') {
          const url = prompt('链接地址');
          if (url) document.execCommand('createLink', false, url);
        }
        if (button.dataset.action === 'image') {
          const url = prompt('图片地址');
          if (url) document.execCommand('insertImage', false, url);
        }
      });

      document.querySelector('#toggleSource').addEventListener('click', () => {
        sourceMode = !sourceMode;
        if (sourceMode) syncSourceFromEditor();
        else syncEditorFromSource();
        editor.classList.toggle('hidden', sourceMode);
        source.classList.toggle('hidden', !sourceMode);
      });

      document.querySelector('#savePost').addEventListener('click', async () => {
        if (sourceMode) syncEditorFromSource();
        syncSourceFromEditor();
        setStatus('保存中...');
        const payload = {
          oldSlug,
          slug: fields.slug.value,
          title: fields.title.value,
          description: fields.description.value,
          date: fields.date.value,
          tags: splitTags(fields.tags.value),
          hidden: currentHidden,
          content: source.value,
        };
        const response = await fetch('/api/post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok) {
          setStatus(data.error || '保存失败', true);
          return;
        }
        oldSlug = data.slug;
        currentHidden = Boolean(data.hidden);
        await loadPosts();
        await loadPost(data.slug);
        setStatus('已保存');
      });

      publishButton.addEventListener('click', async () => {
        const confirmed = confirm('确定提交已保存的文章改动并推送到 GitHub 吗？\\n\\n推送后会触发 GitHub Pages 部署。');
        if (!confirmed) return;

        publishButton.disabled = true;
        setStatus('推送中...');
        setPublishLog('');

        const response = await fetch('/api/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await response.json();

        publishButton.disabled = false;
        if (!response.ok) {
          setStatus(data.error || '推送失败', true);
          setPublishLog(data.output || '');
          return;
        }

        setStatus(data.message || '已推送');
        setPublishLog(data.output || data.message || '');
      });

      visibilityButton.addEventListener('click', async () => {
        if (!oldSlug) return;
        const nextHidden = !currentHidden;
        setStatus(nextHidden ? '隐藏中...' : '显示中...');

        const response = await fetch('/api/post/visibility', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: oldSlug, hidden: nextHidden }),
        });
        const data = await response.json();
        if (!response.ok) {
          setStatus(data.error || '操作失败', true);
          return;
        }

        currentHidden = Boolean(data.hidden);
        const post = posts.find((item) => item.slug === oldSlug);
        if (post) post.hidden = currentHidden;
        updateVisibilityButton();
        await loadPosts();
        setStatus(currentHidden ? '已隐藏' : '已显示');
      });

      deleteButton.addEventListener('click', async () => {
        if (!oldSlug) return;
        const post = posts.find((item) => item.slug === oldSlug);
        const name = post?.title || oldSlug;
        const confirmed = confirm('确定删除文章「' + name + '」吗？\\n\\n这会移除文章文件和列表记录。');
        if (!confirmed) return;

        setStatus('删除中...');
        const response = await fetch('/api/post', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: oldSlug }),
        });
        const data = await response.json();
        if (!response.ok) {
          setStatus(data.error || '删除失败', true);
          return;
        }

        await loadPosts();
        setForm();
        setStatus('已删除');
      });

      loadPosts().then(() => setForm());
    </script>
  </body>
</html>`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      send(res, 200, appHtml, textTypes['.html']);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/posts') {
      await listPosts(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/post') {
      await getPost(res, url.searchParams);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/post') {
      await savePost(res, await readJson(req));
      return;
    }

    if (req.method === 'PATCH' && url.pathname === '/api/post/visibility') {
      await setPostVisibility(res, await readJson(req));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/publish') {
      await publishPosts(res);
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/api/post') {
      await deletePost(res, await readJson(req));
      return;
    }

    notFound(res);
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
      output: error?.output || '',
    });
  }
});

server.listen(port, '127.0.0.1', () => {
  const entry = fileURLToPath(import.meta.url);
  console.log(`Blog admin running at http://127.0.0.1:${port}`);
  console.log(`Project root: ${rootDir}`);
  console.log(`Script: ${entry}`);
});
