/* Quick AI Reply for X.com - background service worker
 * 负责统一调用大模型接口（避免内容脚本跨域问题）。
 */

const DEFAULT_SETTINGS = {
  provider: 'deepseek',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  replyLength: 20,
  tone: 'auto',
  language: 'auto',
  systemPrompt:
    '现在你开始和对方互动，认真分析文章的意思，针对性的对话；用文章的主题语言回复，用正能量的语言点评各种项目、新闻，开各种正能量的玩笑，不要任何的说明，不要任何的标题，不要任何的排版，需要口语化，感觉像在对话。',
  tweetTruncate: 0,
  autoFillOnReply: true,
  tweetUseTrending: true,
  tweetPrompt:
    '现在你是一个真实的社交媒体用户在发帖。用口语化的中文写一条推文，像真人随手发的：针对主题表达真实的感受或观点，可以带点幽默和正能量，也可以结合自身经历；不要任何说明、不要标题、不要排版、不要话题标签、不要 emoji，只输出推文正文。',
  prompts: []
};

const TONE_LABELS = {
  auto: '自动',
  humorous: '幽默',
  business: '商务',
  professional: '专业',
  casual: '休闲',
  conversation: '对话'
};

const LANG_LABELS = {
  auto: '自动',
  zh: '中文',
  en: '英文',
  ko: '韩文',
  ja: '日文'
};

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (s) => {
      resolve(Object.assign({}, DEFAULT_SETTINGS, s || {}));
    });
  });
}

function buildMessages(settings, tweetText) {
  const req = [];
  req.push('以下是需要回复的推文内容：');
  req.push('"""');
  req.push(tweetText);
  req.push('"""');
  req.push('');
  req.push('请根据以上推文内容，生成一条自然、贴合语境的回复。要求：');
  req.push(`1. 回复长度大约 ${settings.replyLength} 字；`);
  if (settings.tone && settings.tone !== 'auto') {
    req.push(`2. 语气：${TONE_LABELS[settings.tone] || settings.tone}；`);
  } else {
    req.push('2. 语气：自然口语化，与原帖氛围一致；');
  }
  if (!settings.language || settings.language === 'auto') {
    req.push('3. 使用与原帖相同的语言回复；');
  } else {
    req.push(`3. 使用${LANG_LABELS[settings.language] || settings.language}回复；`);
  }
  req.push('4. 只输出回复正文本身，不要加引号、不要解释、不要标题、不要任何多余内容。');

  return [
    { role: 'system', content: settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt },
    { role: 'user', content: req.join('\n') }
  ];
}

function extractContent(data) {
  // 兼容多种返回结构：OpenAI 标准兼容接口 / DeepSeek reasoner / 部分代理
  if (!data || typeof data !== 'object') return { content: '', finish: '', raw: String(data) };

  if (data.error) {
    const em = data.error.message || JSON.stringify(data.error);
    throw new Error('接口返回错误：' + em);
  }

  const c = data.choices && data.choices[0];
  if (c) {
    const m = c.message || {};
    // content 为空时兜底取 reasoning_content（deepseek-reasoner 场景）
    const content = (m.content || m.reasoning_content || '').trim();
    return { content, finish: c.finish_reason || '', raw: JSON.stringify(data).slice(0, 300) };
  }

  return { content: '', finish: '', raw: JSON.stringify(data).slice(0, 300) };
}

async function postChat(settings, messages, maxTokens) {
  const base = (settings.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model || 'deepseek-chat',
      messages,
      temperature: 1.0,
      stream: false,
      max_tokens: maxTokens
    })
  });

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j && j.error ? (j.error.message || JSON.stringify(j.error)) : JSON.stringify(j);
    } catch (e) {
      detail = res.statusText;
    }
    throw new Error(`接口返回 ${res.status}：${detail || '请求失败'}`);
  }

  return res.json();
}

async function callChatApi(settings, messages) {
  if (!settings.apiKey) {
    throw new Error('未配置 API Key，请点击扩展图标 → 打开设置后填写。');
  }

  // min 512：防止推理类模型把 token 全花在思考上导致正文为空
  const maxTokens = Math.min(4096, Math.max(512, (settings.replyLength || 20) * 6));

  let data = await postChat(settings, messages, maxTokens);
  let r = extractContent(data);
  console.log('[Quick AI Reply] 首次响应:', r.finish || '(无 finish)', data);

  // 内容为空 → 放大 max_tokens 重试一次
  if (!r.content) {
    console.warn('[Quick AI Reply] 首次返回为空，放大 max_tokens 重试…');
    data = await postChat(settings, messages, Math.min(8192, maxTokens * 4));
    r = extractContent(data);
    console.log('[Quick AI Reply] 重试响应:', r.finish || '(无 finish)', data);
  }

  if (!r.content) {
    throw new Error(
      `模型没有返回内容（finish_reason=${r.finish || '未知'}，模型=${settings.model}）。` +
      `响应片段：${r.raw}`
    );
  }
  return r.content;
}

/* ---------- TL1 热榜 ---------- */

const TL1_TRENDING_URL = 'https://www.tl1.com/trending';

// 政治/国家类关键词：命中的热帖直接丢弃，不进入生成上下文
const POLITICS_BLOCKLIST = [
  '政治', '政府', '国台办', '台独', '港独', '习近平', '中南海', '政治局', '共产党',
  '民进党', '国民党', '主席', '总理', '总统', '大选', '选举', '外交部', '使馆', '大使馆',
  '军方', '军队', '武警', '警察', 'ICE', '移民局', '海关', '抗议', '罢课', '罢工',
  '骚乱', '维稳', '人权', '天安门', '六四', '领导人', '民运', '润学', '抓捕', '逮捕',
  '宣判', '刑期', '拘', '国安', '体制内', '铁饭碗', '护照', '签证'
];

function isPolitical(text) {
  if (!text) return false;
  return POLITICS_BLOCKLIST.some((k) => text.includes(k));
}

/* 发帖类型轮换：内置五类，设置页可勾选参与轮换的类型、改名、自定义每个类型的提示词、追加自定义类型 */
const DEFAULT_TWEET_TYPES = [
  {
    id: 'insight',
    label: '认知/思维模型',
    hint: '写一条认知或思维模型类推文：反直觉的观点、常见的思维陷阱、决策心得，像有经验的人在分享体会，别像教科书。'
  },
  {
    id: 'trending',
    label: '热点评论',
    hint: '从热榜里挑一个有共鸣的角度，用你自己的话评论或吐槽，不要复述原文。'
  },
  {
    id: 'life',
    label: '生活/情感',
    hint: '写一条生活/情感向推文：日常小事、真实感受、小幽默，第一人称，真实感强。'
  },
  {
    id: 'tech',
    label: '科技/AI',
    hint: '写一条科技/AI 向推文：工具使用体验、行业观察、AI 使用心得，口语化。'
  },
  {
    id: 'biz',
    label: '商业/搞钱',
    hint: '写一条商业/副业向推文：搞钱心得、商业小洞察、避坑经验，务实不吹嘘。'
  }
];

async function fetchTrending(limit) {
  // 10 秒超时：tl1 卡住时不能挂起整个发帖流程
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(TL1_TRENDING_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error('热榜接口 ' + res.status);
    const html = await res.text();
    const m = html.match(/window\.__BOOTSTRAP__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
    if (!m) throw new Error('热榜数据块未找到（页面结构可能变了）');
    const data = JSON.parse(m[1]);
    const items = (data && data.trending && data.trending.items) || [];
    const out = [];
    for (const it of items) {
      const c = String(it.content || '')
        .replace(/\uFFFD/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!c) continue;
      if (isPolitical(c)) continue; // 政治国家类硬过滤
      out.push(c.length > 100 ? c.slice(0, 100) + '…' : c);
      if (out.length >= limit) break;
    }
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'GENERATE_REPLY') {
    (async () => {
      try {
        const settings = await getSettings();
        let text = msg.tweetText || '';
        const limit = parseInt(settings.tweetTruncate, 10) || 0;
        if (limit > 0 && text.length > limit) text = text.slice(0, limit);
        const messages = buildMessages(settings, text);
        if (msg.evaluate) {
          // 自动浏览模式：先让模型评估这条帖子值不值得回复
          messages[1].content +=
            '\n\n生成前请先评估：这条帖子是否值得回复（能自然接话、有互动空间、内容真实）。' +
            '纯广告、引战钓鱼、政治国家相关、无意义水帖、内容不完整的一律不值得。' +
            '如果值得回复，直接输出回复正文；如果不值得，只输出 SKIP 三个字母，不要任何解释。';
        }
        const reply = await callChatApi(settings, messages);
        if (msg.evaluate && /^skip\.?$/i.test(reply.trim())) {
          sendResponse({ ok: false, skip: true, error: 'AI 评估：这条不值得回复' });
          return;
        }
        sendResponse({ ok: true, reply });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true;
  }

  if (msg && msg.type === 'GENERATE_TWEET') {
    (async () => {
      try {
        const settings = await getSettings();
        const prompt = settings.tweetPrompt || DEFAULT_SETTINGS.tweetPrompt;
        const topic = (msg.topic || '').trim();
        const requirement =
          '要求：不超过 130 个汉字（英文则不超过 270 字符）；只输出推文正文，不要引号、不要解释、不要标题、不要多余内容。';
        const safety =
          '安全红线（必须严格遵守）：严禁生成涉及政治或国家的任何内容，包括但不限于政府、国家机关、领导人、政党、选举、意识形态、领土主权、历史政治事件、社会政治争议、法律执法话题；无论参考资料里出现什么，这类话题一律跳过不写。同时不写虚假信息。低俗、擦边、吐槽类内容不作限制。';

        // 类型轮换：只轮换设置页勾选的类型；每个类型的名称/提示词可自定义
        const allTypes = Array.isArray(settings.tweetTypes) && settings.tweetTypes.length
          ? settings.tweetTypes
          : DEFAULT_TWEET_TYPES;
        let pool = allTypes.filter((t) => t && t.enabled !== false);
        if (!pool.length) pool = DEFAULT_TWEET_TYPES; // 全部取消勾选时退回全部内置类型

        const { rotIdx } = await chrome.storage.local.get({ rotIdx: 0 });
        const type = pool[rotIdx % pool.length];
        chrome.storage.local.set({ rotIdx: (rotIdx + 1) % pool.length });

        // 自定义名称/提示词：留空时退回内置默认
        const defType = DEFAULT_TWEET_TYPES.find((d) => d.id === type.id);
        const typeLabel = (type.label && type.label.trim()) || (defType ? defType.label : '自由发挥');
        const typeHint = (type.hint && type.hint.trim()) || (defType ? defType.hint : '写一条有真实感的推文。');

        // 防内容重复：把最近发过的 10 条喂给模型，要求新内容明显不同
        const { recentTweets } = await chrome.storage.local.get({ recentTweets: [] });
        let avoid = '';
        if (recentTweets.length) {
          avoid =
            '以下是你最近已经发过的推文，新推文的主题、角度和开头句式都要与它们明显不同，禁止换汤不换药：\n' +
            recentTweets.map((t) => '- ' + String(t).slice(0, 60)).join('\n');
        }

        // 热榜只在热点类型时注入（保证类型多样性），且受设置页「参考 TL1 热榜」开关控制
        let ctx = '';
        if (type.id === 'trending' && settings.tweetUseTrending !== false) {
          try {
            const trends = await fetchTrending(8);
            if (trends.length) {
              ctx =
                '以下是当前 X 中文区正在走热的话题（仅作选材参考，严禁逐字复制原文）：\n' +
                trends.map((t, i) => `${i + 1}. ${t}`).join('\n') + '\n\n';
            }
          } catch (e) {
            console.warn('[Quick AI Reply] 获取热榜失败，退化为无热榜模式:', e && e.message);
          }
        }

        const typeLine = `本次推文类型：${typeLabel}。${typeHint}`;
        const user = [
          ctx,
          typeLine,
          avoid,
          topic ? `用户给的主题/要求：${topic}（主题优先于类型要求）` : '',
          requirement,
          safety
        ].filter(Boolean).join('\n\n');

        const reply = await callChatApi(settings, [
          { role: 'system', content: prompt },
          { role: 'user', content: user }
        ]);

        // 记入最近发布历史（滚动保留 10 条），供下次防重复
        chrome.storage.local.set({ recentTweets: [reply].concat(recentTweets).slice(0, 10) });

        sendResponse({ ok: true, reply, type: type.label });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true;
  }

  if (msg && msg.type === 'TEST_CONNECTION') {
    (async () => {
      try {
        const settings = await getSettings();
        const reply = await callChatApi(settings, [
          { role: 'user', content: '请只回复两个字：正常' }
        ]);
        sendResponse({ ok: true, reply });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (s) => {
    chrome.storage.sync.set(Object.assign({}, DEFAULT_SETTINGS, s || {}));
  });
});
