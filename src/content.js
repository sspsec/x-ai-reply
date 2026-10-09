/* Quick AI Reply for X.com - content script
 * 1) 在每条帖子的操作栏注入一个 "AI" 按钮
 * 2) 监听原生的 Reply 按钮点击，自动打开回复框并生成 AI 回复
 */
(function () {
  'use strict';

  const DEFAULTS = { autoFillOnReply: true };

  let settings = Object.assign({}, DEFAULTS);
  chrome.storage.sync.get(DEFAULTS, (s) => Object.assign(settings, s || {}));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const k in changes) settings[k] = changes[k].newValue;
  });

  let pendingTweet = null; // 等待回复框出现后要处理的推文
  let generating = false;
  let injectScheduled = false;
  let lastFill = { text: '', ts: 0 }; // 上一次成功填入的回复（防重复 + 覆盖判断）
  let lastRequest = { tweet: '', ts: 0 }; // 上一次发起生成请求的推文（防重复触发）
  let lastReplyEditor = null; // 最近一次回复流程使用的编辑器（发送时按它的容器作用域找按钮）

  /* ---------- 工具函数 ---------- */

  function findEditor() {
    return (
      document.querySelector('[data-testid="tweetTextarea_0"][contenteditable="true"]') ||
      document.querySelector('div[role="textbox"][data-testid^="tweetTextarea"]') ||
      document.querySelector('[data-testid="tweetTextarea_0"]')
    );
  }

  // 回复编辑器：精确匹配「回复」弹窗或时间线内联回复框。
  // 关键：并行模式下自动发帖的「发帖」弹窗可能同时在 DOM 里，
  // 全局 querySelector 会抓到发帖弹窗的编辑器，把回复填错地方
  function findReplyEditor() {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (const d of dialogs) {
      const btn = d.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
      const label = btn ? (btn.textContent || '') : '';
      if (!/回复|^reply$/i.test(label)) continue; // 跳过「发帖」弹窗
      const ed =
        d.querySelector('[data-testid="tweetTextarea_0"][contenteditable="true"]') ||
        d.querySelector('div[role="textbox"][data-testid^="tweetTextarea"]');
      if (ed) return ed;
    }
    // 时间线内联回复框（不在弹窗里）
    const inline =
      document.querySelector('article [data-testid="tweetTextarea_0"][contenteditable="true"]') ||
      document.querySelector('article div[role="textbox"][data-testid^="tweetTextarea"]');
    return inline;
  }

  function waitForReplyEditor(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return (async () => {
      for (;;) {
        const ed = findReplyEditor();
        if (ed) return ed;
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
  }

  function getArticle(el) {
    return el ? el.closest('article[data-testid="tweet"], article') : null;
  }

  function getTweetText(article) {
    if (!article) return '';
    const el = article.querySelector('[data-testid="tweetText"]');
    return el ? el.innerText.trim() : '';
  }

  function toast(msg, type) {
    let el = document.getElementById('quickai-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'quickai-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'quickai-toast' + (type ? ' quickai-' + type : '');
    el.style.display = 'block';
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.style.display = 'none';
    }, 2800);
  }

  function normWs(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  // 验证专用：去掉全部空白再比。
  // 关键：X 把 \n 渲染成独立段落，textContent 拼接时段落之间【没有】空白字符；
  // 目标文本里的 \n 若折叠成空格，"明白。 参数" vs 实际 "明白。参数" 永远匹配不上，
  // 会把已成功的插入误判为失败（随后清空反而毁掉成功结果）
  function stripWs(s) {
    return (s || '').replace(/\s+/g, '');
  }

  // 按行归一化：每行 trim、去掉末尾空行。用于段落结构比对（innerText 保留渲染后的换行）
  function normLines(s) {
    const arr = String(s || '')
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.trim());
    while (arr.length && !arr[arr.length - 1]) arr.pop();
    return arr.join('\n');
  }

  // 编辑器顶层段落数（Lexical/Draft 每个段落是一个 div/p 块）
  function blockCount(editor) {
    try {
      const contents = editor.querySelector('[data-contents]');
      const root = contents || editor;
      let n = 0;
      for (const el of root.children) {
        if (el.tagName === 'DIV' || el.tagName === 'P') n++;
      }
      return n;
    } catch (e) {
      return 0;
    }
  }

  // 匹配等级：
  // 'exact' —— 内容和段落结构都对（空行还在）。结构验证双保险：
  //            ① innerText 按行归一化后与目标一致；② 块元素数量 >= 目标行数
  // 'loose' —— 内容进去了（stripWs 匹配），但段落结构可能被吞（空行丢了）
  // null    —— 没进去
  function matchInEditor(editor, target) {
    if (stripWs(editor.textContent).indexOf(stripWs(target)) === -1) return null;
    if (String(target).indexOf('\n') === -1) return 'exact'; // 单行无所谓结构
    const lines = String(target).split('\n');
    if (normLines(editor.innerText) === normLines(target)) return 'exact';
    if (blockCount(editor) >= lines.length) return 'exact';
    return 'loose';
  }

  // 轮询等待编辑器内容匹配目标。
  // 关键 1：X 编辑器对 paste/insert 的 DOM 更新是异步的，dispatch 后立刻同步读
  //         textContent 读到的还是旧内容，必须轮询等它真正落进编辑器。
  // 关键 2：requireStructure=true 时只认 'exact'（空行结构也必须对），
  //         结构被吞的内容宁可判失败换下一个策略，也不能带着丢空行的结果提前收工。
  // 关键 3：编辑器被 X 卸载（isConnected=false）时立即返回，不在死元素上空等 6 秒。
  async function waitEditorText(editor, target, timeoutMs, requireStructure) {
    const deadline = Date.now() + timeoutMs;
    let best = null;
    for (;;) {
      if (!editor.isConnected) return null;
      const m = matchInEditor(editor, target);
      if (m === 'exact') return 'exact';
      if (m === 'loose') best = 'loose';
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    return requireStructure ? null : best;
  }

  function moveCursorToEnd(editor) {
    try {
      const sel = window.getSelection();
      const r2 = document.createRange();
      r2.selectNodeContents(editor);
      r2.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r2);
    } catch (e) {}
  }

  function clearEditor(editor) {
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete');
    } catch (e) {}
  }

  // 框架原生路径：X 的编辑器（Draft.js/Lexical）监听 beforeinput 事件来同步内部状态。
  // execCommand 只改 DOM，框架状态可能仍是"空"→ 发送键永远不亮。
  // beforeinput 走框架的输入处理，状态和 DOM 才会一致。
  function fireBeforeInput(editor, inputType, data) {
    try {
      editor.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType,
          data: data == null ? null : data,
          bubbles: true,
          cancelable: true,
          composed: true
        })
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  // 是否有输入框带着草稿内容（发帖/回复弹窗）。
  // 带草稿刷新页面会触发浏览器的 beforeunload 确认弹窗（"不保存内容重新加载？"），
  // 把自动浏览/发帖整个流程卡死在那里 —— 刷新前必须先检查
  function anyDraftText() {
    const eds = document.querySelectorAll('[data-testid^="tweetTextarea"]');
    for (const ed of eds) {
      if (ed.isConnected && (ed.textContent || '').trim()) return true;
    }
    return false;
  }

  // 关掉我们自动点开的回复弹窗：AI 评估跳过 / 流程出错时窗口不能留在页面上，
  // 残留弹窗会挡住后续滚动、评论和发帖。
  // 只关发送键文字是「回复/Reply」的弹窗 —— 并行模式下绝不能误关发帖弹窗
  function closeReplyDialogSoon() {
    const close = () => {
      try {
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const dlg of dialogs) {
          const btn = dlg.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
          const label = btn ? (btn.textContent || '').trim() : '';
          if (!/回复|^reply$/i.test(label)) continue; // 不是回复弹窗，跳过
          const x = dlg.querySelector('[data-testid="app-bar-close"]');
          if (x) {
            realClick(x);
          } else {
            document.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
            );
          }
          return;
        }
      } catch (e) {}
    };
    setTimeout(close, 400);
    setTimeout(close, 1200); // 弹窗可能尚未挂载完，补一次
  }

  // 多策略填入，每步验证成功即停。
  // 顺序关键（上一版的坑）：整段 insertText 会把 \n 全吞掉、空行全丢，但 stripWs 验证
  // 恰好把 \n 也去掉 —— 丢空行的结果能"验证成功"，导致链路提前停掉。
  // 所以结构化策略必须排在前面，吞结构的整段插入降为最后保底：
  // A. beforeinput 逐行（框架原生路径，发送键才会亮）      —— 要求结构精确
  // B. 逐行 execCommand insertText + 行间 insertParagraph  —— 要求结构精确
  // D. paste 事件（Lexical 的 paste 会按 \n 拆段落，保空行）—— 多行时接受 loose 保底
  // C. 整段 execCommand insertText —— 最后保底（丢空行，但至少有字能发）
  async function insertTextIntoEditor(editor, text) {
    const log = [];
    const lines = String(text).split('\n');
    const multi = lines.length > 1;

    // 编辑器已被 X 卸载（弹窗重渲染/关闭）：dispatch 什么都不会生效，
    // 直接上报 false，由调用方重新打开弹窗重试，不在死元素上烧完全部策略
    if (!editor.isConnected) {
      console.warn('[Quick AI Reply] 编辑器已失效（DOM 已卸载），跳过填入');
      return false;
    }

    const runStrategy = async (name, fill, timeoutMs, requireStructure) => {
      try {
        editor.focus();
      } catch (e) {}
      try {
        fill();
      } catch (e) {}
      const r = await waitEditorText(editor, text, timeoutMs, requireStructure && multi);
      if (r) return true;
      log.push(name + ':' + JSON.stringify(normWs(editor.textContent).slice(0, 30)));
      return false;
    };

    // 策略 A：beforeinput 事件序列（逐行 insertText + 行间 insertParagraph）
    clearEditor(editor);
    if (
      await runStrategy(
        'A框架',
        () => {
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]) fireBeforeInput(editor, 'insertText', lines[i]);
            if (i < lines.length - 1) fireBeforeInput(editor, 'insertParagraph', null);
          }
        },
        1500,
        true
      )
    )
      return true;
    if (!editor.isConnected) return false;

    // 策略 B：逐行 execCommand（上一策略可能留下残缺内容，先清掉）
    if (normWs(editor.textContent)) clearEditor(editor);
    if (
      await runStrategy(
        'B逐行',
        () => {
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]) document.execCommand('insertText', false, lines[i]);
            if (i < lines.length - 1) {
              if (!document.execCommand('insertParagraph')) {
                document.execCommand('insertLineBreak');
              }
            }
          }
        },
        1500,
        true
      )
    )
      return true;
    if (!editor.isConnected) return false;

    // 策略 D：paste 兜底（Lexical 异步处理，轮询等它生效）。
    // 框里有残缺内容（不匹配目标）就清掉重来，防止越抹越少
    if (stripWs(editor.textContent)) {
      if (stripWs(editor.textContent).indexOf(stripWs(text)) === -1) clearEditor(editor);
    }
    if (
      await runStrategy(
        'D粘贴',
        () => {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          editor.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
          );
        },
        2500,
        false // paste 是最后一个保结构的手段：内容进了但空行丢了，也比失败强
      )
    )
      return true;
    if (!editor.isConnected) return false;

    // 策略 C：整段插入（最后保底，\n 会被吞、空行全丢，仅保证有字可发）
    if (normWs(editor.textContent)) clearEditor(editor);
    const okC = await runStrategy(
      'C整段',
      () => {
        document.execCommand('insertText', false, text);
      },
      1200,
      false
    );
    if (!okC) {
      console.warn('[Quick AI Reply] 四种填入策略均未成功，各策略后编辑器内容:', log.join(' | '));
    }
    return okC;
  }

  async function insertText(text, force, editorEl) {
    const editor = editorEl || findEditor();
    if (!editor) return false;
    if (!editor.isConnected) {
      console.warn('[Quick AI Reply] 编辑器已失效（DOM 已卸载），需要重新打开弹窗');
      return false;
    }

    // 只允许覆盖三种情况：空编辑器 / 上一次是我们自己填的内容（重新生成） / force（AI 发推强制覆盖）
    // 对比用 stripWs：编辑器会把 \n 变成段落（textContent 无空白），逐字对比会把自己的内容误判成"用户内容"
    const current = (editor.textContent || '').trim();
    if (current && stripWs(current) !== stripWs(lastFill.text) && !force) return 'has-content';

    const ok = await insertTextIntoEditor(editor, text);
    if (ok) moveCursorToEnd(editor);
    return ok;
  }

  async function generateAndFill(tweetText) {
    if (generating) return;
    if (!tweetText) {
      toast('未能读取到帖子内容', 'err');
      return;
    }
    // 8 秒内同一条推文只生成一次，防止双击 / MutationObserver 时序重复触发导致内容填两遍
    if (tweetText === lastRequest.tweet && Date.now() - lastRequest.ts < 8000) return;
    lastRequest = { tweet: tweetText, ts: Date.now() };
    generating = true;
    toast('AI 正在生成回复…');
    try {
      // 自动浏览模式下让 AI 先评估帖子是否值得回复（SKIP 协议）
      const resp = await chrome.runtime.sendMessage({
        type: 'GENERATE_REPLY',
        tweetText,
        evaluate: !!autoBrowse
      });
      if (resp && resp.skip) {
        // 值不值得都算处理过了：不重置 lastRequest，避免同一帖反复评估
        toast('AI 评估：这条不值得回复，已跳过');
        closeReplyDialogSoon(); // 回复窗是我们自动点开的，跳过后必须关掉，否则残留挡路
        return;
      }
      if (!resp || !resp.ok) throw new Error(resp ? resp.error : '扩展无响应');
      // 等回复编辑器出现（弹窗/内联），最多 3 秒；并行模式下绝不能抓到发帖弹窗的编辑器。
      // 生成耗时数秒，期间 X 可能重渲染弹窗卸载编辑器 —— 填失败后重找编辑器再试一轮
      let ed = await waitForReplyEditor(3000);
      let r = null;
      for (let i = 0; i < 2; i++) {
        if (!ed || !ed.isConnected) {
          lastRequest = { tweet: '', ts: 0 };
          toast('未找到回复输入框，请先点击 Reply', 'err');
          if (autoBrowse) closeReplyDialogSoon();
          return;
        }
        lastReplyEditor = ed;
        r = await insertText(resp.reply, false, ed);
        if (r === true || r === 'has-content') break;
        ed = await waitForReplyEditor(2000);
      }
      if (r === 'has-content') {
        lastRequest = { tweet: '', ts: 0 };
        toast('回复框已有内容，未自动覆盖', 'err');
      } else if (r === true) {
        lastFill = { text: resp.reply, ts: Date.now() };
        if (autoBrowse && autoBrowse.autoSend) {
          toast('已填入 AI 回复，稍后自动发送', 'ok');
          setTimeout(trySendReply, 900 + Math.random() * 900);
        } else {
          toast('已填入 AI 回复，确认后发送', 'ok');
        }
      } else {
        lastRequest = { tweet: '', ts: 0 };
        toast('未找到回复输入框，请先点击 Reply', 'err');
        if (autoBrowse) closeReplyDialogSoon(); // 自动流程留下的空回复窗要收掉
      }
    } catch (e) {
      lastRequest = { tweet: '', ts: 0 };
      toast('生成失败：' + (e && e.message ? e.message : e), 'err');
      if (autoBrowse) closeReplyDialogSoon(); // 自动评论出错也不能把回复窗留在页面上
    } finally {
      generating = false;
      if (autoBrowse) autoBrowse.busy = false;
    }
  }

  function triggerReply(article) {
    const text = getTweetText(article);
    const replyBtn = article.querySelector('button[data-testid="reply"]');
    if (replyBtn) {
      pendingTweet = text;
      replyBtn.click();
    } else {
      generateAndFill(text);
    }
  }

  /* ---------- 注入 AI 按钮 ---------- */

  function makeButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quickai-btn';
    b.title = 'AI 自动回复';
    b.textContent = 'AI';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const article = getArticle(b);
      if (!article) return;
      pendingTweet = null;
      triggerReply(article);
    });
    return b;
  }

  function inject() {
    injectScheduled = false;
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    articles.forEach((article) => {
      const replyBtn = article.querySelector('button[data-testid="reply"]');
      if (!replyBtn) return;
      const group = replyBtn.closest('div[role="group"]');
      if (!group || group.querySelector('.quickai-btn')) return;
      group.appendChild(makeButton());
    });
  }

  function scheduleInject() {
    if (injectScheduled) return;
    injectScheduled = true;
    requestAnimationFrame(inject);
  }

  /* ---------- AI 发推 ---------- */

  let tweetPanel = null;
  let autoBrowse = null; // 自动浏览状态
  let autoBtnEl = null;
  let autoStatusEl = null;

  function findComposeEditor() {
    // 发帖弹窗内的编辑器：限定在 dialog 里找，避免误抓页面上的回复框
    return (
      document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"][contenteditable="true"]') ||
      document.querySelector('[role="dialog"] div[role="textbox"][data-testid^="tweetTextarea"]')
    );
  }

  function openCompose() {
    return new Promise((resolve) => {
      const dlg = document.querySelector('[role="dialog"]');
      if (dlg) {
        // 已有弹窗：如果它就是发帖弹窗（发送按钮文字是 发帖/Post），直接复用
        // （上次失败残留的发帖框，覆盖填入即可，不用关了重开）
        const sendBtn = dlg.querySelector('[data-testid="tweetButton"]');
        const label = sendBtn ? (sendBtn.textContent || '').trim() : '';
        const ed = findComposeEditor();
        if (ed && /发帖|帖子|^post$/i.test(label)) return resolve(ed);
        // 其他弹窗（回复框等）：Escape 关掉再开。递归有上限，防止碰到关不掉的
        // 常驻弹层时无限循环、自动发帖整个卡死
        openCompose._esc = (openCompose._esc || 0) + 1;
        if (openCompose._esc > 3) {
          openCompose._esc = 0;
          console.warn('[Quick AI Reply] 弹窗关不掉，直接尝试点发帖按钮');
        } else {
          try {
            document.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
            );
          } catch (e) {}
          setTimeout(() => openCompose().then(resolve), 450);
          return;
        }
      }
      openCompose._esc = 0;
      const btn =
        document.querySelector('[data-testid="SideNav_NewTweet_Button"]') ||
        document.querySelector('a[href="/compose/post"]') ||
        document.querySelector('a[href="/compose/tweet"]');
      if (!btn) return resolve(null);
      try {
        btn.click();
      } catch (e) {
        return resolve(null);
      }
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        const ed = findComposeEditor();
        if (ed) {
          clearInterval(timer);
          resolve(ed);
        } else if (tries > 40) {
          clearInterval(timer);
          resolve(null);
        }
      }, 200);
    });
  }

  /* ---------- 自动浏览 + 随机评论 ---------- */

  function hashText(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return String(h);
  }

  /* ---------- 会话持久化（页面刷新后自动恢复任务） ---------- */

  const RESUME_KEY = 'quickai_session_resume';

  /* ---------- 关注配额（15 分钟滑动窗口 + 每日上限，跨刷新持久化） ---------- */

  const FOLLOW_QUOTA_KEY = 'quickai_follow_quota';

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function loadFollowQuota() {
    try {
      const d = JSON.parse(localStorage.getItem(FOLLOW_QUOTA_KEY) || 'null');
      if (d && d.dayKey === todayKey() && Array.isArray(d.window)) return d;
    } catch (e) {}
    return { dayKey: todayKey(), dayCount: 0, window: [] };
  }

  function saveFollowQuota(st) {
    try {
      localStorage.setItem(
        FOLLOW_QUOTA_KEY,
        JSON.stringify({ dayKey: st.dayKey, dayCount: st.dayCount, window: st.window.slice(-40) })
      );
    } catch (e) {}
  }

  function persistSession() {
    try {
      const data = {};
      if (autoBrowse) {
        data.browse = {
          prob: autoBrowse.prob,
          interval: autoBrowse.interval,
          max: autoBrowse.max,
          autoSend: autoBrowse.autoSend,
      // 进度与去重集合一并保存：刷新后面板数字才能接上，
      // 已评论过的帖子刷新后不会重复评论
      viewed: autoBrowse.viewed,
      commented: autoBrowse.commented,
      commentedIds: Array.from(autoBrowse.commentedIds).slice(-200),
      interact: autoBrowse.interact,
      likes: autoBrowse.likes,
      visits: autoBrowse.visits
    };
      }
      if (autoPost) {
        data.post = {
          minM: autoPost.minM,
          maxM: autoPost.maxM,
          max: autoPost.max,
          sent: autoPost.sent, // 已发条数也存：否则刷新后配额归零，会多发
          nextAt: autoPost.nextAt || null // 下次发帖时刻：刷新后按剩余时间恢复，间隔不重置
        };
      }
      localStorage.setItem(RESUME_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  function resumeSession() {
    let data = null;
    try {
      const raw = localStorage.getItem(RESUME_KEY);
      if (!raw) return;
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (data && data.browse && !autoBrowse) {
      startAutoBrowse(data.browse, true);
      toast('页面已刷新，自动浏览已恢复', 'ok');
    }
    if (data && data.post && !autoPost) {
      startAutoPost(data.post, true);
      toast('自动发帖计划已恢复', 'ok');
    }
  }

  function startAutoBrowse(cfg, resumed) {
    // 自动浏览/自动发帖/自动关注三个任务可并行运行（关注会 SPA 跳到粉丝页，
    // 浏览在粉丝页没有帖子可评，属无害空转；关注跑完会自动跳回主页）
    autoBrowse = {
      prob: cfg.prob,
      interval: cfg.interval,
      max: cfg.max,
      autoSend: cfg.autoSend,
      // 刷新恢复：接上之前的进度和已评论去重集合（新启动时都是 0/空）
      viewed: cfg.viewed || 0,
      commented: cfg.commented || 0,
      commentedIds: new Set(cfg.commentedIds || []),
      interact: cfg.interact !== false, // 模拟互动（随机点赞/逛主页）开关，默认开
      likes: cfg.likes || 0,
      visits: cfg.visits || 0,
      profileVisiting: false,
      busy: false,
      ticks: 0,
      nextRefresh: 8 + Math.floor(Math.random() * 8), // 每 8~15 个 tick 随机刷新一次页面
      timer: null
    };
    // 递归 setTimeout 替代 setInterval：每次间隔带 ±30% 随机抖动，节奏更像真人
    (function loop() {
      if (!autoBrowse) return;
      const jitter = cfg.interval * 1000 * (0.7 + Math.random() * 0.6);
      autoBrowse.timer = setTimeout(() => {
        if (!autoBrowse) return;
        autoBrowseTick();
        loop();
      }, jitter);
    })();
    syncAutoBtn();
    persistSession();
    if (!resumed) toast('自动浏览已开始', 'ok');
    setTimeout(autoBrowseTick, 1200);
  }

  function stopAutoBrowse(msg) {
    if (autoBrowse && autoBrowse.timer) clearTimeout(autoBrowse.timer);
    autoBrowse = null;
    syncAutoBtn();
    persistSession();
    if (autoStatusEl) autoStatusEl.textContent = msg || '已停止';
    if (msg) toast(msg);
  }

  function syncAutoBtn() {
    if (autoBtnEl) {
      autoBtnEl.textContent = autoBrowse ? '停止自动浏览' : '开始自动浏览';
      autoBtnEl.classList.toggle('quickai-panel-btn-active', !!autoBrowse);
    }
    updateAutoStatus();
  }

  function updateAutoStatus() {
    if (!autoStatusEl || !autoBrowse) return;
    autoStatusEl.textContent =
      '已浏览 ' + autoBrowse.viewed +
      ' · 已评论 ' + autoBrowse.commented + '/' + autoBrowse.max +
      ' · 已赞 ' + autoBrowse.likes +
      (autoBrowse.autoSend ? ' · 自动发送开' : '');
  }

  function visibleArticles() {
    const vh = window.innerHeight;
    const list = [];
    document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => {
      const r = a.getBoundingClientRect();
      if (r.top < vh * 0.85 && r.bottom > vh * 0.2) list.push(a);
    });
    return list;
  }

  /* ---------- 模拟互动：随机点赞 / 随机点头像逛主页 ---------- */

  function randomLike() {
    const btns = [];
    visibleArticles().forEach((a) => {
      // 已赞过的帖子按钮变成 unlike，天然只命中没赞过的
      const b = a.querySelector('button[data-testid="like"]');
      if (b && isClickableSendButton(b)) btns.push(b);
    });
    if (!btns.length) return;
    try {
      realClick(btns[Math.floor(Math.random() * btns.length)]);
    } catch (e) {}
  }

  function randomProfileVisit() {
    const links = [];
    visibleArticles().forEach((a) => {
      // 头像链接（UserAvatar-Container-<用户名>），点它 = 点头像进主页
      const l = a.querySelector('a[data-testid^="UserAvatar-Container"]');
      if (l) links.push(l);
    });
    if (!links.length) return;
    const st = autoBrowse;
    if (st) st.profileVisiting = true;
    try {
      realClick(links[Math.floor(Math.random() * links.length)]); // SPA 跳到对方主页
    } catch (e) {
      if (st) st.profileVisiting = false;
      return;
    }
    // 逛 2~5 秒随机后退出：history.back 是 SPA 返回，内容脚本状态不丢、不触发刷新守卫
    const dwell = 2000 + Math.random() * 3000;
    setTimeout(() => {
      try {
        history.back();
      } catch (e) {}
      setTimeout(() => {
        if (autoBrowse) autoBrowse.profileVisiting = false;
      }, 800);
    }, dwell);
  }

  function findCommentTarget() {
    const cands = visibleArticles().filter((a) => {
      if (!a.querySelector('button[data-testid="reply"]')) return false;
      const text = getTweetText(a);
      if (!text || text.length < 15) return false;
      if (autoBrowse.commentedIds.has(hashText(text))) return false;
      return true;
    });
    if (!cands.length) return null;
    return cands[Math.floor(Math.random() * cands.length)];
  }

  function autoBrowseTick() {
    const st = autoBrowse;
    if (!st || st.busy) return;
    st.viewed++;
    st.ticks++;
    updateAutoStatus();

    // 偶尔刷新页面：每 8~15 个 tick 随机触发一次。
    // 发帖进行中、或任何输入框带草稿时【不能刷】——
    // 带草稿刷新会触发浏览器 beforeunload 确认弹窗（"不保存内容重新加载？"），
    // 自动流程会整个卡在弹窗上。推迟几个 tick 再试
    if (st.ticks >= st.nextRefresh) {
      if ((autoPost && autoPost.busy) || st.profileVisiting || anyDraftText()) {
        st.nextRefresh = st.ticks + 3;
      } else {
        persistSession();
        toast('自动浏览：刷新页面（稍后自动继续）', 'ok');
        setTimeout(() => {
          // 800ms 窗口内自动发帖可能刚好启动：reload 前再守一次
          if ((autoPost && autoPost.busy) || st.profileVisiting || anyDraftText()) return;
          location.reload();
        }, 800);
        return;
      }
    }

    // 模拟人类滑动：随机幅度平滑滚动
    window.scrollBy({
      top: window.innerHeight * (0.6 + Math.random() * 0.5),
      behavior: 'smooth'
    });

    // 滚动稳定后，按概率随机挑一条可见帖子评论
    setTimeout(() => {
      const st2 = autoBrowse;
      if (!st2 || st2.busy) return;
      if (st2.commented >= st2.max) {
        stopAutoBrowse('已达本轮评论上限，自动浏览停止');
        return;
      }
      // 自动发帖进行中（弹窗打开/生成/发送）：这个周期只刷不评，避免回复框和发帖框打架
      if (autoPost && autoPost.busy) return;

      // —— 模拟互动：12% 概率随机点赞（每轮上限 30），8% 概率点头像进主页逛 2~5 秒（上限 12 次）——
      if (st2.interact && !(autoPost && autoPost.busy)) {
        if (st2.likes < 30 && Math.random() < 0.12) {
          st2.likes++;
          randomLike();
        } else if (!st2.profileVisiting && st2.visits < 12 && Math.random() < 0.08) {
          st2.visits++;
          randomProfileVisit();
        }
      }
      if (st2.profileVisiting) return; // 正逛别人主页：本周期不评论，回来再继续

      if (Math.random() * 100 >= st2.prob) return;

      const target = findCommentTarget();
      if (!target) return;

      const text = getTweetText(target);
      st2.commentedIds.add(hashText(text));
      st2.commented++;
      st2.busy = true;
      updateAutoStatus();
      toast('自动评论第 ' + st2.commented + ' 条…');

      pendingTweet = null;
      triggerReply(target);
      // 兜底：流程卡住 60 秒后自动释放 busy
      setTimeout(() => {
        if (autoBrowse) autoBrowse.busy = false;
      }, 60000);
    }, 1800 + Math.random() * 1600);
  }

  function isClickableSendButton(b) {
    if (!b || b.disabled) return false;
    if (b.getAttribute('aria-disabled') === 'true') return false;
    const rect = b.getBoundingClientRect();
    return !(rect.width === 0 && rect.height === 0);
  }

  // 按编辑器所在容器找发送键：回复弹窗的键 ≠ 发帖弹窗的键。
  // 并行模式下两个弹窗可能同时在 DOM 里，全局查询会抓到对方的键白点一通
  function findSendButtonForEditor(editor, preferInline) {
    const sels = preferInline
      ? ['[data-testid="tweetButtonInline"]', '[data-testid="tweetButton"]']
      : ['[data-testid="tweetButton"]', '[data-testid="tweetButtonInline"]'];
    const scope =
      editor && editor.isConnected
        ? editor.closest('[role="dialog"]') || editor.closest('article')
        : null;
    if (scope) {
      for (const sel of sels) {
        for (const b of scope.querySelectorAll(sel)) {
          if (isClickableSendButton(b)) return b;
        }
      }
      return null; // 容器内没有可用键：宁可等，也不去点别的弹窗的键
    }
    return findSendButton(preferInline);
  }

  function findSendButton(preferInline) {
    // 页面里可能同时存在 inline 回复按钮和弹窗按钮（含隐藏残留的），
    // querySelector 会永远命中 DOM 里靠前的死按钮。必须遍历全部候选，挑第一个可见且可用的
    const sels = preferInline
      ? ['[data-testid="tweetButtonInline"]', '[data-testid="tweetButton"]']
      : ['[data-testid="tweetButton"]', '[data-testid="tweetButtonInline"]'];
    for (const sel of sels) {
      const list = document.querySelectorAll(sel);
      for (const b of list) {
        if (isClickableSendButton(b)) return b;
      }
    }
    return null;
  }

  // 只在重试全部失败时调用（不在每次重试时打日志刷屏）
  function logSendButtonDiagnostics() {
    try {
      console.warn(
        '[Quick AI Reply] 发送按钮重试耗尽，当前候选状态:',
        JSON.stringify(
          Array.from(
            document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')
          ).map((b) => ({
            testid: b.getAttribute('data-testid'),
            disabled: b.disabled,
            ariaDisabled: b.getAttribute('aria-disabled'),
            visibleW: Math.round(b.getBoundingClientRect().width),
            visibleH: Math.round(b.getBoundingClientRect().height),
            text: (b.textContent || '').slice(0, 10)
          }))
        )
      );
    } catch (e) {}
  }

  function realClick(el) {
    // 补全指针事件序列再 click，覆盖 X 监听 pointer/mouse 事件的场景
    const opts = { bubbles: true, cancelable: true, view: window };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
    } catch (e) {
      try { el.click(); } catch (e2) {}
    }
  }

  function pressCmdEnter() {
    // 发帖/回复弹窗原生支持 Cmd/Ctrl+Enter 发送，作为按钮点不动的兜底
    const target =
      document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"][contenteditable="true"]') ||
      document.activeElement ||
      document.body;
    const isMac = /mac/i.test(navigator.platform || '');
    try {
      ['keydown', 'keyup'].forEach((type) => {
        target.dispatchEvent(
          new KeyboardEvent(type, {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            metaKey: isMac,
            ctrlKey: !isMac,
            bubbles: true,
            cancelable: true
          })
        );
      });
    } catch (e) {}
  }

  function clickSendAndVerify(findBtn, getEditorText) {
    // 点发送 → 验证：编辑器被清空/关闭 或 发送按钮消失（X 发送成功会清空编辑器）→ 没成功就重试
    const hadText = getEditorText();
    const btn = findBtn();
    if (btn) {
      realClick(btn);
    } else if (hadText !== null) {
      // 找不到可点按钮：Cmd/Ctrl+Enter 快捷键兜底
      pressCmdEnter();
    }
    const hadBtn = !!btn;
    return new Promise((resolve) => {
      let tries = 0;
      const t = setInterval(() => {
        tries++;
        const now = getEditorText();
        const btnStill = !!findBtn();
        // 编辑器消失/内容变化/按钮消失，任一出现 = 已发送
        if (hadText !== null && (now === null || now !== hadText || (hadBtn && !btnStill))) {
          clearInterval(t);
          resolve(true);
        } else if (tries > 8) {
          clearInterval(t);
          resolve(false);
        }
      }, 400);
    });
  }

  function trySendGeneric(findBtn, getEditorText, attempt) {
    attempt = attempt || 0;
    return clickSendAndVerify(findBtn, getEditorText).then((ok) => {
      if (ok) return true;
      // 按钮还在处理输入 / 点了没反应：重试最多 8 次 ≈ 7 秒（X 处理输入可能偏慢）
      if (attempt < 8) {
        return new Promise((r) => setTimeout(() => r(trySendGeneric(findBtn, getEditorText, attempt + 1)), 900));
      }
      logSendButtonDiagnostics(); // 只在最终失败时打一条诊断，重试过程不刷屏
      return false;
    });
  }

  function trySendReply(attempt) {
    attempt = attempt || 0;
    if (!autoBrowse) return Promise.resolve(false);
    const editorText = () => {
      const ed = lastReplyEditor || findReplyEditor();
      return ed && ed.isConnected ? (ed.textContent || '').trim() : null;
    };
    // 只在回复编辑器自己的容器（弹窗/article）里找发送键，绝不碰发帖弹窗的键
    const findBtn = () => findSendButtonForEditor(lastReplyEditor || findReplyEditor(), false);
    return trySendGeneric(findBtn, editorText, attempt).then((ok) => {
      if (ok) {
        toast('已自动发送回复', 'ok');
      } else {
        toast('发送按钮一直不可用，请手动发送', 'err');
      }
      return ok;
    });
  }

  /* ---------- 自动发帖（定时 · 类型轮换） ---------- */

  let autoPost = null;
  let autoPostBtnEl = null;
  let autoPostStatusEl = null;

  function startAutoPost(cfg, resumed) {
    // 与自动浏览、自动关注并行：三个任务互不接管
    autoPost = {
      minM: cfg.minM,
      maxM: cfg.maxM,
      max: cfg.max,
      sent: cfg.sent || 0, // 刷新恢复：接上已发条数，配额不重置
      busy: false,
      timer: null
    };
    syncPostBtn();
    if (!resumed) toast('自动发帖已开始，每 ' + cfg.minM + '~' + cfg.maxM + ' 分钟随机发一条', 'ok');
    if (resumed) {
      // 刷新恢复：接上刷新前剩下的倒计时，而不是重新随机一整轮（否则间隔看起来像被重置）
      const remain = cfg.nextAt ? cfg.nextAt - Date.now() : 0;
      if (remain > 5000) {
        schedulePost(remain);
      } else {
        // 已到期（刷新正好卡在发帖时刻）或时间戳丢失：几秒内补发
        schedulePost(3000 + Math.random() * 6000);
      }
    } else {
      schedulePost(3000);
    }
  }

  function stopAutoPost(msg) {
    if (autoPost && autoPost.timer) clearTimeout(autoPost.timer);
    autoPost = null;
    syncPostBtn();
    persistSession();
    if (autoPostStatusEl) autoPostStatusEl.textContent = msg || '已停止';
    if (msg) toast(msg);
  }

  function syncPostBtn() {
    if (autoPostBtnEl) {
      autoPostBtnEl.textContent = autoPost ? '停止自动发帖' : '开始自动发帖';
      autoPostBtnEl.classList.toggle('quickai-panel-btn-active', !!autoPost);
    }
  }

  function updatePostStatus(extra) {
    if (autoPostStatusEl && autoPost) {
      autoPostStatusEl.textContent =
        '已发 ' + autoPost.sent + '/' + autoPost.max + (extra ? ' · ' + extra : '');
    }
  }

  function schedulePost(initialDelayMs) {
    if (!autoPost) return;
    const minMs = autoPost.minM * 60000;
    const maxMs = autoPost.maxM * 60000;
    const delay = initialDelayMs || minMs + Math.random() * (maxMs - minMs);
    autoPost.nextAt = Date.now() + delay; // 记录下次发帖时刻：刷新后按剩余时间恢复，间隔不会被重置
    const mins = Math.max(1, Math.round(delay / 60000));
    updatePostStatus('下次约 ' + mins + ' 分钟后');
    autoPost.timer = setTimeout(autoPostTick, delay);
    persistSession(); // 每次排程都落盘：任何时刻刷新都能恢复准确的倒计时
  }

  async function autoPostTick() {
    const st = autoPost;
    if (!st || st.busy) return;
    if (st.sent >= st.max) {
      stopAutoPost('已达发帖上限，自动发帖停止');
      return;
    }
    // 自动评论进行中：先让评论走完，30 秒后再发，避免回复框和发帖弹窗打架
    if (autoBrowse && autoBrowse.busy) {
      updatePostStatus('等当前评论完成…');
      st.timer = setTimeout(autoPostTick, 30000);
      return;
    }
    st.busy = true;
    try {
      toast('自动发帖：正在生成…');
      const opened = await openCompose();
      if (!opened) throw new Error('打开发帖框失败，请检查是否已登录');
      await new Promise((r) => setTimeout(r, 400));
      const resp = await chrome.runtime.sendMessage({ type: 'GENERATE_TWEET', topic: '' });
      if (!resp || !resp.ok) throw new Error(resp ? resp.error : '扩展无响应');
      // 生成 API 调用耗时数秒，期间 X 可能重渲染弹窗、卸载旧编辑器（填入全空的根因）。
      // 填入失败或编辑器失效 → 重新打开发帖框再填，最多 3 轮
      let r = null;
      for (let i = 0; i < 3; i++) {
        let ed = findComposeEditor();
        if (!ed || !ed.isConnected) {
          console.warn('[Quick AI Reply] 发帖编辑器已失效，重新打开弹窗（第 ' + (i + 1) + ' 轮）');
          ed = await openCompose();
          if (!ed) throw new Error('发帖编辑器失效且重开失败');
          await new Promise((res) => setTimeout(res, 500)); // 等弹窗渲染稳定
        }
        r = await insertText(resp.reply, true, ed);
        if (r === true) break;
        await new Promise((res) => setTimeout(res, 800));
      }
      if (r !== true) {
        const dbg = findComposeEditor();
        console.warn(
          '[Quick AI Reply] 填入验证失败诊断:',
          '编辑器存在=' + !!dbg,
          '编辑器内容="' + (dbg ? (dbg.textContent || '').slice(0, 80) : '(无)') + '"',
          '目标文本前 80 字="' + String(resp.reply).slice(0, 80) + '"'
        );
        throw new Error('填入发帖框失败（诊断已输出到控制台）');
      }
      updatePostStatus('发送中…');
      toast('已生成（' + (resp.type || '') + '），即将发送', 'ok');
      const sentOk = await trySendPost();
      if (sentOk) {
        st.sent++; // 只在真实发送成功后才计数，失败不占名额
        toast('已发布（' + (resp.type || '') + '）', 'ok');
      } else {
        toast('发送按钮不可用，这条未发出，请手动处理', 'err');
      }
    } catch (e) {
      toast('自动发帖失败：' + (e && e.message ? e.message : e), 'err');
    } finally {
      if (autoPost) {
        autoPost.busy = false;
        if (autoPost.sent >= autoPost.max) {
          stopAutoPost('已达发帖上限，自动发帖停止');
        } else {
          schedulePost();
        }
      }
    }
  }

  function trySendPost(attempt) {
    attempt = attempt || 0;
    const editorText = () => {
      const ed = findComposeEditor();
      return ed && ed.isConnected ? (ed.textContent || '').trim() : null;
    };
    // 只在发帖弹窗自己的容器里找发送键
    const findBtn = () => findSendButtonForEditor(findComposeEditor(), false);
    return trySendGeneric(findBtn, editorText, attempt);
  }

  /* ---------- 关注认证粉丝（回关蓝V） ---------- */

  let autoFollow = null;
  let autoFollowBtnEl = null;
  let autoFollowStatusEl = null;

  function getOwnHandle() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (!link) return '';
    const m = (link.getAttribute('href') || '').match(/^\/([^/]+)/);
    return m ? m[1] : '';
  }

  function onFollowersPage(handle) {
    // 兼容 /handle/followers 和 /handle/verified_followers，带尾斜杠也认
    if (/^\/[^/]+\/(verified_)?followers\/?$/i.test(location.pathname)) return true;
    return !!handle && location.pathname.toLowerCase() === '/' + handle.toLowerCase() + '/followers';
  }

  async function goToFollowers() {
    // 已经在粉丝列表页：handle 就算提取失败也能直接用
    if (/^\/[^/]+\/(verified_)?followers\/?$/i.test(location.pathname) &&
        document.querySelector('div[data-testid="UserCell"], div[data-testid="cellInnerDiv"]')) {
      return true;
    }
    const h = getOwnHandle();
    if (!h) {
      console.warn('[Quick AI Reply] goToFollowers: 侧边栏找不到个人资料链接（AppTabBar_Profile_Link），拿不到 handle');
      return false;
    }
    if (onFollowersPage(h)) return true;
    // SPA 内部跳转（不刷新页面，内容脚本状态不丢）：优先直接点 followers 链接
    const followersSel = 'a[href="/' + h + '/followers" i], a[href="/' + h + '/verified_followers" i]';
    const direct = document.querySelector(followersSel);
    if (direct) {
      direct.click();
    } else {
      const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      if (!profile) {
        console.warn('[Quick AI Reply] goToFollowers: 侧边栏找不到个人资料链接');
        return false;
      }
      profile.click();
      // 轮询等粉丝 tab 出现（写死 1.2 秒在慢网络下必挂，最多等 10 秒）
      let tab = null;
      for (let i = 0; i < 40 && !tab; i++) {
        tab = document.querySelector(followersSel);
        if (!tab) await new Promise((r) => setTimeout(r, 250));
      }
      if (!tab) {
        console.warn('[Quick AI Reply] goToFollowers: 个人主页已打开但没找到粉丝 tab 链接, pathname=' + location.pathname);
        return false;
      }
      tab.click();
    }
    // 等粉丝列表渲染：UserCell 是行组件，cellInnerDiv 是外层单元格（X 改版时的兜底）
    for (let i = 0; i < 60; i++) {
      if (document.querySelector('div[data-testid="UserCell"], div[data-testid="cellInnerDiv"]')) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.warn('[Quick AI Reply] goToFollowers: 已跳转但列表 15 秒内没渲染出来, pathname=' + location.pathname);
    return false;
  }

  // 认证标志检测：蓝V/金V 的 testid 和 aria-label 有多种语言/版本变体，全部覆盖
  function isVerifiedCell(cell) {
    if (cell.querySelector('svg[data-testid="icon-verified"]')) return true;
    const svgs = cell.querySelectorAll('svg[aria-label]');
    for (const s of svgs) {
      const al = s.getAttribute('aria-label') || '';
      if (/verif|认证/i.test(al)) return true;
    }
    return false;
  }

  // 扫描全部落空时的控制台诊断：下次再报"扫描完毕"，把这段输出贴出来一眼定位
  function logFollowDiagnostics() {
    try {
      const cells = document.querySelectorAll('div[data-testid="UserCell"], div[data-testid="cellInnerDiv"]');
      const sample = Array.from(cells)
        .slice(0, 12)
        .map((cell) => {
          const btn = cell.querySelector(
            'button[data-testid$="-follow"], button[data-testid="follow"], button[data-testid$="-unfollow"]'
          );
          return {
            btn: btn ? btn.getAttribute('data-testid') : null,
            文字: btn ? (btn.textContent || '').trim().slice(0, 8) : null,
            认证: isVerifiedCell(cell)
          };
        });
      console.warn(
        '[Quick AI Reply] 关注扫描诊断: 候选行数量=' + cells.length,
        JSON.stringify(sample, null, 1)
      );
    } catch (e) {}
  }

  function findFollowBackTarget() {
    // UserCell 是标准行组件；cellInnerDiv 兜底（X 改版时行组件可能换名）
    let cells = document.querySelectorAll('div[data-testid="UserCell"]');
    if (!cells.length) cells = document.querySelectorAll('div[data-testid="cellInnerDiv"]');
    for (const cell of cells) {
      // X 新版把关注按钮的 testid 改成了 <用户ID>-follow（如 2757796010-follow），
      // 旧版才是固定的 follow —— 用 $= 后缀匹配两种都覆盖。
      // -unfollow 是已关注/待确认，天然不匹配
      const btn = cell.querySelector('button[data-testid$="-follow"], button[data-testid="follow"]');
      if (!btn) continue; // 已关注 / 待确认的不处理
      // 只点「回关」按钮：确保是真实粉丝（推荐关注显示的是「关注」，会被排除）。
      // contains 匹配 + 去掉全部空白：aria-label 带 @用户名、文字里有空格都能兜住
      const label = (btn.textContent || '').replace(/\s+/g, '');
      if (!/回关|follow\s*back/i.test(label)) continue;
      if (!isVerifiedCell(cell)) continue;
      const link = cell.querySelector('a[href^="/"]');
      const href = link ? (link.getAttribute('href') || '').toLowerCase() : '';
      if (!href || autoFollow.done.has(href)) continue;
      return { btn, href };
    }
    return null;
  }

  function startAutoFollow(cfg) {
    // 三个任务并行，不再互斥接管；唯一要求：跳页前等发帖流程走完（不然把发帖弹窗连根拔掉）
    const quota = loadFollowQuota();
    autoFollow = {
      winMax: cfg.winMax || 10, // 每 15 分钟最多关注数（滑动窗口）
      dayMax: cfg.dayMax || 300, // 每日最多关注数
      followed: 0,
      dayCount: quota.dayCount || 0, // 今日已关注（跨刷新累计）
      dayKey: quota.dayKey,
      window: quota.window || [], // 15 分钟窗口内的关注时间戳
      scanned: 0,
      idleRounds: 0,
      busy: false,
      nextDelay: null, // 窗口满时 followLoop 用这个长间隔等待
      done: new Set(),
      timer: null
    };
    syncFollowBtn();
    (async () => {
      let waited = 0;
      while (autoPost && autoPost.busy && waited < 60) {
        updateFollowStatus('等当前发帖完成后再跳转…');
        await new Promise((r) => setTimeout(r, 2000));
        waited++;
      }
      if (!autoFollow) return;
      toast('正在打开关注者页面…');
      const ok = await goToFollowers();
      if (!ok) {
        stopAutoFollow('打不开关注者页面，请确认已登录后重试');
        return;
      }
      toast('开始回关认证粉丝（每 15 分钟 ≤' + autoFollow.winMax + '，每日 ≤' + autoFollow.dayMax + '）', 'ok');
      autoFollowTick();
      followLoop();
    })();
  }

  function followLoop() {
    if (!autoFollow) return;
    // 窗口满时 nextDelay 是长等待（到窗口腾出位置），平时 4.5~9 秒随机防机械节奏
    const delay = autoFollow.nextDelay || 4500 + Math.random() * 4500;
    autoFollow.nextDelay = null;
    autoFollow.timer = setTimeout(() => {
      if (!autoFollow) return;
      autoFollowTick();
      followLoop();
    }, delay);
  }

  function stopAutoFollow(msg, goHome) {
    if (autoFollow && autoFollow.timer) clearTimeout(autoFollow.timer);
    autoFollow = null;
    syncFollowBtn();
    if (autoFollowStatusEl) autoFollowStatusEl.textContent = msg || '已停止';
    if (msg) toast(msg);
    // 自然跑完（扫完列表/达每日上限）时跳回主页，让并行的自动浏览回到时间线
    if (goHome && (autoBrowse || autoPost)) {
      const home = document.querySelector('a[data-testid="AppTabBar_Home_Link"]');
      if (home) home.click();
    }
  }

  function syncFollowBtn() {
    if (autoFollowBtnEl) {
      autoFollowBtnEl.textContent = autoFollow ? '停止关注' : '开始关注认证粉丝';
      autoFollowBtnEl.classList.toggle('quickai-panel-btn-active', !!autoFollow);
    }
    updateFollowStatus();
  }

  function updateFollowStatus(extra) {
    if (!autoFollowStatusEl || !autoFollow) return;
    if (extra) {
      autoFollowStatusEl.textContent = extra;
      return;
    }
    autoFollowStatusEl.textContent =
      '已关注 ' + autoFollow.followed +
      ' · 今日 ' + autoFollow.dayCount + '/' + autoFollow.dayMax +
      ' · 本15分钟 ' + autoFollow.window.length + '/' + autoFollow.winMax;
  }

  function autoFollowTick() {
    const st = autoFollow;
    if (!st || st.busy) return;
    st.scanned++;

    // 配额闸门 1：每日上限（跨刷新累计）—— 到顶直接收工并跳回主页
    if (st.dayKey !== todayKey()) {
      st.dayKey = todayKey();
      st.dayCount = 0;
      saveFollowQuota(st);
    }
    if (st.dayCount >= st.dayMax) {
      stopAutoFollow('已达每日关注上限（' + st.dayMax + ' 个），自动停止', true);
      return;
    }

    // 配额闸门 2：15 分钟滑动窗口 —— 满了就等窗口里最早一次关注满 15 分钟再继续
    const now = Date.now();
    st.window = st.window.filter((t) => now - t < 15 * 60 * 1000);
    if (st.window.length >= st.winMax) {
      const waitMs = 15 * 60 * 1000 - (now - st.window[0]) + 3000;
      updateFollowStatus('15 分钟窗口已满，约 ' + Math.max(1, Math.ceil(waitMs / 60000)) + ' 分钟后继续');
      st.nextDelay = waitMs;
      return;
    }
    updateFollowStatus();

    // 滚动加载更多（模拟真人滑动）
    window.scrollBy({
      top: window.innerHeight * (0.6 + Math.random() * 0.5),
      behavior: 'smooth'
    });

    setTimeout(() => {
      const st2 = autoFollow;
      if (!st2) return;
      const t = findFollowBackTarget();
      if (!t) {
        st2.idleRounds = (st2.idleRounds || 0) + 1;
        if (st2.idleRounds >= 6) {
          logFollowDiagnostics(); // 落空收工时吐诊断：候选行的按钮/文字/认证标志实际长啥样
          stopAutoFollow('列表扫描完毕，没有更多可回关的认证粉丝', true);
        }
        return;
      }
      st2.idleRounds = 0;
      st2.done.add(t.href);
      st2.busy = true;
      try {
        t.btn.click();
      } catch (e) {}
      // 受保护账户会弹确认框，顺手点确认
      setTimeout(() => {
        const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
        if (confirm) confirm.click();
        if (autoFollow) {
          autoFollow.followed++;
          autoFollow.dayCount++;
          autoFollow.window.push(Date.now());
          saveFollowQuota(autoFollow); // 每次关注都落盘：刷新不会洗掉限速窗口
          autoFollow.busy = false;
          updateFollowStatus();
          toast(
            '已回关认证粉丝 ' + autoFollow.followed +
            '（今日 ' + autoFollow.dayCount + '/' + autoFollow.dayMax + '）', 'ok'
          );
        }
      }, 800);
    }, 1200 + Math.random() * 1200);
  }

  function ensureTweetPanel() {
    if (tweetPanel) return tweetPanel;

    tweetPanel = document.createElement('div');
    tweetPanel.className = 'quickai-panel';
    // 阻止事件冒泡到 X 页面（避免触发全局快捷键等）
    ['click', 'keydown', 'keyup', 'mousedown'].forEach((ev) =>
      tweetPanel.addEventListener(ev, (e) => e.stopPropagation())
    );

    const head = document.createElement('div');
    head.className = 'quickai-panel-head';

    const title = document.createElement('div');
    title.className = 'quickai-panel-title';
    title.textContent = 'AI 发推';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'quickai-panel-close';
    close.textContent = '×';
    close.title = '关闭面板';

    head.appendChild(title);
    head.appendChild(close);

    const ta = document.createElement('textarea');
    ta.className = 'quickai-panel-input';
    ta.placeholder = '主题或要求（可选）\n留空则按设置页提示词 + TL1 热榜生成';

    const row = document.createElement('div');
    row.className = 'quickai-panel-row';

    const gen = document.createElement('button');
    gen.type = 'button';
    gen.className = 'quickai-panel-btn quickai-panel-btn-primary';
    gen.textContent = '生成并填入';

    gen.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (gen.disabled) return;
      gen.disabled = true;
      gen.textContent = '生成中…';
      try {
        const opened = await openCompose();
        if (!opened) throw new Error('打开发帖框失败，请手动点击 X 的发帖按钮');
        await new Promise((r) => setTimeout(r, 400));
        const resp = await chrome.runtime.sendMessage({
          type: 'GENERATE_TWEET',
          topic: ta.value.trim()
        });
        if (!resp || !resp.ok) throw new Error(resp ? resp.error : '扩展无响应');
        // 生成耗时数秒，弹窗可能重渲染 —— 填入前实时重找编辑器
        const r = await insertText(resp.reply, true, findComposeEditor() || opened); // AI 发推：强制覆盖
        if (r === true) {
          toast('已填入（' + (resp.type || '') + '），确认后发布', 'ok');
          ta.value = '';
          tweetPanel.style.display = 'none';
        } else {
          console.warn('[Quick AI Reply] 手动发推填入失败:', r, '编辑器存在=' + !!findComposeEditor());
          toast(r === 'has-content' ? '发帖框已有内容，未自动覆盖' : '填入失败，请看控制台诊断', 'err');
        }
      } catch (err) {
        toast('生成推文失败：' + (err && err.message ? err.message : err), 'err');
      } finally {
        gen.disabled = false;
        gen.textContent = '生成并填入';
      }
    });

    close.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      tweetPanel.style.display = 'none';
    });

    row.appendChild(gen);
    tweetPanel.appendChild(head);
    tweetPanel.appendChild(ta);
    tweetPanel.appendChild(row);

    /* --- 自动浏览 + 随机评论控制区 --- */
    const el2 = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };

    tweetPanel.appendChild(el2('div', 'quickai-panel-hr'));
    tweetPanel.appendChild(el2('div', 'quickai-panel-title', '自动浏览 + 随机评论'));
    tweetPanel.appendChild(
      el2('div', 'quickai-panel-hint', '可与自动发帖同时开；刷贴过程中会偶尔自动刷新页面（任务自动恢复）')
    );

    const probRow = el2('div', 'quickai-panel-field');
    probRow.appendChild(el2('span', null, '评论概率'));
    const prob = el2('input');
    prob.type = 'range';
    prob.min = '5';
    prob.max = '50';
    prob.step = '5';
    prob.value = '15';
    const probVal = el2('b', null, '15%');
    prob.addEventListener('input', () => {
      probVal.textContent = prob.value + '%';
    });
    probRow.appendChild(prob);
    probRow.appendChild(probVal);
    tweetPanel.appendChild(probRow);

    const ivRow = el2('div', 'quickai-panel-field');
    ivRow.appendChild(el2('span', null, '滚动间隔'));
    const iv = el2('input');
    iv.type = 'range';
    iv.min = '4';
    iv.max = '20';
    iv.step = '1';
    iv.value = '8';
    const ivVal = el2('b', null, '8s');
    iv.addEventListener('input', () => {
      ivVal.textContent = iv.value + 's';
    });
    ivRow.appendChild(iv);
    ivRow.appendChild(ivVal);
    tweetPanel.appendChild(ivRow);

    const mxRow = el2('div', 'quickai-panel-field');
    mxRow.appendChild(el2('span', null, '最多评论'));
    const mx = el2('input', 'quickai-panel-num');
    mx.type = 'number';
    mx.min = '1';
    mx.max = '50';
    mx.value = '5';
    mxRow.appendChild(mx);
    mxRow.appendChild(el2('span', null, '条'));
    tweetPanel.appendChild(mxRow);

    const sendRow = el2('label', 'quickai-panel-field quickai-panel-check');
    const sendChk = el2('input');
    sendChk.type = 'checkbox';
    sendRow.appendChild(sendChk);
    sendRow.appendChild(el2('span', null, '自动发送（默认只填入，更安全）'));
    tweetPanel.appendChild(sendRow);

    const interRow = el2('label', 'quickai-panel-field quickai-panel-check');
    const interChk = el2('input');
    interChk.type = 'checkbox';
    interChk.checked = true;
    interRow.appendChild(interChk);
    interRow.appendChild(el2('span', null, '随机点赞 / 点头像逛主页（更像真人）'));
    tweetPanel.appendChild(interRow);

    const autoBtn = el2('button', 'quickai-panel-btn quickai-panel-btn-warn', '开始自动浏览');
    autoBtn.type = 'button';
    autoBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (autoBrowse) {
        stopAutoBrowse('已停止自动浏览');
      } else {
        startAutoBrowse({
          prob: parseInt(prob.value, 10) || 15,
          interval: parseInt(iv.value, 10) || 8,
          max: parseInt(mx.value, 10) || 5,
          autoSend: sendChk.checked,
          interact: interChk.checked
        });
      }
      syncAutoBtn();
    });
    autoBtnEl = autoBtn;
    tweetPanel.appendChild(autoBtn);

    const statusLine = el2('div', 'quickai-panel-status', '未开始');
    autoStatusEl = statusLine;
    tweetPanel.appendChild(statusLine);

    /* --- 自动发帖（定时 · 类型轮换） --- */
    tweetPanel.appendChild(el2('div', 'quickai-panel-hr'));
    tweetPanel.appendChild(el2('div', 'quickai-panel-title', '自动发帖（定时 · 轮换类型）'));
    tweetPanel.appendChild(
      el2('div', 'quickai-panel-hint', '可与自动浏览同时开：刷贴到点就发帖，发完继续刷。按设置页勾选的类型轮换，间隔随机；会真实发布，注意频率')
    );

    const pIvRow = el2('div', 'quickai-panel-field');
    pIvRow.appendChild(el2('span', null, '间隔'));
    const pmin = el2('input', 'quickai-panel-num');
    pmin.type = 'number';
    pmin.min = '3';
    pmin.max = '120';
    pmin.value = '10';
    const pmax = el2('input', 'quickai-panel-num');
    pmax.type = 'number';
    pmax.min = '3';
    pmax.max = '120';
    pmax.value = '15';
    pIvRow.appendChild(pmin);
    pIvRow.appendChild(el2('span', null, '~'));
    pIvRow.appendChild(pmax);
    pIvRow.appendChild(el2('span', null, '分钟（随机）'));
    tweetPanel.appendChild(pIvRow);

    const pCntRow = el2('div', 'quickai-panel-field');
    pCntRow.appendChild(el2('span', null, '最多发'));
    const pmaxCount = el2('input', 'quickai-panel-num');
    pmaxCount.type = 'number';
    pmaxCount.min = '1';
    pmaxCount.max = '30';
    pmaxCount.value = '5';
    pCntRow.appendChild(pmaxCount);
    pCntRow.appendChild(el2('span', null, '条'));
    tweetPanel.appendChild(pCntRow);

    const postBtn = el2('button', 'quickai-panel-btn quickai-panel-btn-warn', '开始自动发帖');
    postBtn.type = 'button';
    postBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (autoPost) {
        stopAutoPost('已停止自动发帖');
      } else {
        const a = parseInt(pmin.value, 10) || 10;
        const b = parseInt(pmax.value, 10) || 15;
        startAutoPost({
          minM: Math.min(a, b),
          maxM: Math.max(a, b),
          max: parseInt(pmaxCount.value, 10) || 5
        });
      }
      syncPostBtn();
    });
    autoPostBtnEl = postBtn;
    tweetPanel.appendChild(postBtn);

    const postStatus = el2('div', 'quickai-panel-status', '未开始');
    autoPostStatusEl = postStatus;
    tweetPanel.appendChild(postStatus);

    /* --- 关注认证粉丝（回关蓝V） --- */
    tweetPanel.appendChild(el2('div', 'quickai-panel-hr'));
    tweetPanel.appendChild(el2('div', 'quickai-panel-title', '关注认证粉丝'));
    tweetPanel.appendChild(
      el2('div', 'quickai-panel-hint', '可与自动浏览/发帖同时开；只回关带认证标志的粉丝（只点「回关」按钮）；15 分钟滑动窗口 + 每日上限双层限速（跨刷新累计）')
    );

    const fWinRow = el2('div', 'quickai-panel-field');
    fWinRow.appendChild(el2('span', null, '15 分钟最多'));
    const fwin = el2('input', 'quickai-panel-num');
    fwin.type = 'number';
    fwin.min = '1';
    fwin.max = '50';
    fwin.value = '10';
    fWinRow.appendChild(fwin);
    fWinRow.appendChild(el2('span', null, '个'));
    tweetPanel.appendChild(fWinRow);

    const fDayRow = el2('div', 'quickai-panel-field');
    fDayRow.appendChild(el2('span', null, '每天最多'));
    const fday = el2('input', 'quickai-panel-num');
    fday.type = 'number';
    fday.min = '1';
    fday.max = '500';
    fday.value = '300';
    fDayRow.appendChild(fday);
    fDayRow.appendChild(el2('span', null, '个'));
    tweetPanel.appendChild(fDayRow);

    const followBtn = el2('button', 'quickai-panel-btn quickai-panel-btn-warn', '开始关注认证粉丝');
    followBtn.type = 'button';
    followBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (autoFollow) {
        stopAutoFollow('已停止关注认证粉丝');
      } else {
        startAutoFollow({
          winMax: parseInt(fwin.value, 10) || 10,
          dayMax: parseInt(fday.value, 10) || 300
        });
      }
      syncFollowBtn();
    });
    autoFollowBtnEl = followBtn;
    tweetPanel.appendChild(followBtn);

    const fStatus = el2('div', 'quickai-panel-status', '未开始');
    autoFollowStatusEl = fStatus;
    tweetPanel.appendChild(fStatus);

    document.body.appendChild(tweetPanel);

    // 面板是懒构建的（第一次点悬浮球才创建），而任务可能在面板构建前
    // 就已由 resumeSession 恢复运行 —— 构建完成后立即按真实状态刷新按钮/状态行，
    // 否则面板永远显示"未开始"，按钮文字与实际运行状态不符
    syncAutoBtn();
    syncPostBtn();
    syncFollowBtn();

    // 面板控件回填实际生效的参数（恢复运行时配置可能与默认值不同）
    if (autoBrowse) {
      prob.value = String(autoBrowse.prob);
      probVal.textContent = autoBrowse.prob + '%';
      iv.value = String(autoBrowse.interval);
      ivVal.textContent = autoBrowse.interval + 's';
      mx.value = String(autoBrowse.max);
      sendChk.checked = !!autoBrowse.autoSend;
      interChk.checked = autoBrowse.interact !== false;
    }
    if (autoPost) {
      pmin.value = String(autoPost.minM);
      pmax.value = String(autoPost.maxM);
      pmaxCount.value = String(autoPost.max);
      if (autoPost.nextAt) {
        const left = Math.max(1, Math.round((autoPost.nextAt - Date.now()) / 60000));
        updatePostStatus('下次约 ' + left + ' 分钟后');
      } else {
        updatePostStatus();
      }
    }

    return tweetPanel;
  }

  function toggleTweetPanel() {
    const p = ensureTweetPanel();
    p.style.display = p.style.display === 'block' ? 'none' : 'block';
    if (p.style.display === 'block') {
      const ta = p.querySelector('textarea');
      if (ta) ta.focus();
    }
  }

  function makeFab() {
    if (document.querySelector('.quickai-fab')) return;
    const f = document.createElement('button');
    f.type = 'button';
    f.className = 'quickai-fab';
    f.textContent = 'AI发推';
    f.title = 'AI 生成推文';
    f.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleTweetPanel();
    });
    document.body.appendChild(f);
  }

  /* ---------- 事件监听 ---------- */

  // 记录用户点击的 Reply 对应的推文
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest && e.target.closest('button[data-testid="reply"]');
      if (!btn) return;
      if (!settings.autoFillOnReply) return;
      if (pendingTweet) return;
      const article = getArticle(btn);
      const text = getTweetText(article);
      if (text) pendingTweet = text;
    },
    true
  );

  // 监听回复框出现
  const observer = new MutationObserver(() => {
    scheduleInject();
    if (pendingTweet) {
      const editor = findEditor();
      if (editor) {
        const t = pendingTweet;
        pendingTweet = null;
        setTimeout(() => generateAndFill(t), 400);
      }
    }
  });

  function start() {
    if (!document.body) {
      setTimeout(start, 300);
      return;
    }
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleInject();
    makeFab();
    resumeSession(); // 页面刷新后自动恢复进行中的自动浏览/自动发帖
    console.log('[Quick AI Reply] content script loaded');
  }

  start();
})();
