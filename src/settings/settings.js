/* Quick AI Reply for X.com - 设置页脚本 */

/* 内置发帖类型（与 background.js 保持一致；可改名/改提示词/增删/勾选参与轮换） */
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
  tweetTypes: JSON.parse(JSON.stringify(DEFAULT_TWEET_TYPES)),
  tweetPrompt:
    '现在你是一个真实的社交媒体用户在发帖。用口语化的中文写一条推文，像真人随手发的：针对主题表达真实的感受或观点，可以带点幽默和正能量，也可以结合自身经历；不要任何说明、不要标题、不要排版、不要话题标签、不要 emoji，只输出推文正文。',
  prompts: []
};

const TONES = [
  ['auto', '自动'],
  ['humorous', '幽默'],
  ['business', '商务'],
  ['professional', '专业'],
  ['casual', '休闲'],
  ['conversation', '对话']
];

const LANGS = [
  ['auto', '自动'],
  ['zh', '中文'],
  ['en', '英文'],
  ['ko', '韩文'],
  ['ja', '日文']
];

const PROVIDER_INFO = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    label: 'Deepseek API Key',
    link: 'https://platform.deepseek.com/api_keys'
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    label: 'OpenAI API Key',
    link: 'https://platform.openai.com/api-keys'
  },
  custom: {
    baseUrl: '',
    model: '',
    label: 'API Key',
    link: ''
  }
};

let state = Object.assign({}, DEFAULT_SETTINGS);

const $ = (id) => document.getElementById(id);

function status(msg, type) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + (type || '');
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.textContent = '';
    el.className = 'status';
  }, 4000);
}

function renderRadios(containerId, name, options) {
  const box = $(containerId);
  box.innerHTML = '';
  options.forEach(([value, label]) => {
    const l = document.createElement('label');
    l.className = 'radio';
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = name;
    r.value = value;
    r.addEventListener('change', () => {
      state[name] = value;
    });
    const s = document.createElement('span');
    s.textContent = label;
    l.appendChild(r);
    l.appendChild(s);
    box.appendChild(l);
  });
}

function setRadio(name, value) {
  document.querySelectorAll('input[name="' + name + '"]').forEach((r) => {
    r.checked = r.value === value;
  });
}

function updateProviderUi() {
  const info = PROVIDER_INFO[state.provider] || PROVIDER_INFO.custom;
  $('keyLabel').textContent = info.label + '：';
  const link = $('getKeyLink');
  if (info.link) {
    link.style.display = '';
    link.href = info.link;
  } else {
    link.style.display = 'none';
  }
  const custom = state.provider === 'custom';
  $('baseUrlField').hidden = !custom;
  $('modelField').hidden = !custom;
  $('baseUrl').value = state.baseUrl || '';
  $('model').value = state.model || '';
}

function fillForm() {
  $('provider').value = state.provider;
  $('apiKey').value = state.apiKey;
  $('replyLength').value = state.replyLength;
  $('replyLengthNum').value = state.replyLength;
  $('systemPrompt').value = state.systemPrompt;
  $('charCount').textContent = (state.systemPrompt || '').length;
  $('tweetPrompt').value = state.tweetPrompt || '';
  $('tweetCharCount').textContent = (state.tweetPrompt || '').length;
  $('tweetUseTrending').checked = state.tweetUseTrending !== false;
  $('tweetTruncate').value = state.tweetTruncate;
  $('autoFillOnReply').checked = !!state.autoFillOnReply;
  setRadio('tone', state.tone);
  setRadio('language', state.language);
  updateProviderUi();
  renderTypes();
  renderPrompts();
}

function collectForm() {
  state.provider = $('provider').value;
  state.apiKey = $('apiKey').value.trim();
  const info = PROVIDER_INFO[state.provider] || {};
  state.baseUrl = ($('baseUrl').value.trim() || info.baseUrl || 'https://api.deepseek.com');
  state.model = ($('model').value.trim() || info.model || 'deepseek-chat');
  state.replyLength = parseInt($('replyLengthNum').value, 10) || 20;
  state.systemPrompt = $('systemPrompt').value;
  state.tweetPrompt = $('tweetPrompt').value;
  state.tweetUseTrending = $('tweetUseTrending').checked;
  state.tweetTruncate = parseInt($('tweetTruncate').value, 10) || 0;
  state.autoFillOnReply = $('autoFillOnReply').checked;
  return state;
}

/* 发帖类型轮换设置：勾选参与 + 改名 + 自定义提示词 + 增删 */
function renderTypes() {
  const box = $('typeList');
  box.innerHTML = '';
  if (!Array.isArray(state.tweetTypes) || !state.tweetTypes.length) {
    state.tweetTypes = JSON.parse(JSON.stringify(DEFAULT_TWEET_TYPES));
  }

  state.tweetTypes.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'type-row';

    const top = document.createElement('div');
    top.className = 'type-row-top';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = t.enabled !== false;
    chk.title = '勾选 = 参与自动发帖轮换';
    chk.addEventListener('change', () => {
      state.tweetTypes[i].enabled = chk.checked;
    });

    const label = document.createElement('input');
    label.type = 'text';
    label.className = 'type-label';
    label.value = t.label || '';
    label.placeholder = '类型名称';
    label.addEventListener('input', () => {
      state.tweetTypes[i].label = label.value;
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-sm btn-danger';
    del.textContent = '删';
    del.title = '删除该类型';
    del.onclick = () => {
      state.tweetTypes.splice(i, 1);
      renderTypes();
    };

    top.appendChild(chk);
    top.appendChild(label);
    top.appendChild(del);

    const hint = document.createElement('textarea');
    hint.className = 'type-hint';
    hint.rows = 2;
    hint.value = t.hint || '';
    hint.placeholder = '该类型的提示词（留空用内置默认）';
    hint.addEventListener('input', () => {
      state.tweetTypes[i].hint = hint.value;
    });

    row.appendChild(top);
    row.appendChild(hint);
    box.appendChild(row);
  });
}

function renderPrompts() {  const box = $('promptList');
  box.innerHTML = '';
  const prompts = state.prompts || [];
  if (!prompts.length) {
    box.innerHTML = '<div class="hint">暂无保存的提示词。可先编辑系统提示词，再点击下方按钮保存。</div>';
    return;
  }
  prompts.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'prompt-row';

    const name = document.createElement('span');
    name.className = 'prompt-name';
    name.textContent = p.name;

    const use = document.createElement('button');
    use.className = 'btn btn-sm';
    use.textContent = '使用';
    use.onclick = () => {
      $('systemPrompt').value = p.content;
      state.systemPrompt = p.content;
      $('charCount').textContent = (p.content || '').length;
      status('已应用提示词：' + p.name, 'ok');
    };

    const del = document.createElement('button');
    del.className = 'btn btn-sm btn-danger';
    del.textContent = '删除';
    del.onclick = () => {
      state.prompts.splice(i, 1);
      renderPrompts();
      chrome.storage.sync.set({ prompts: state.prompts });
    };

    row.appendChild(name);
    row.appendChild(use);
    row.appendChild(del);
    box.appendChild(row);
  });
}

/* ---------- 事件绑定 ---------- */

renderRadios('toneRadios', 'tone', TONES);
renderRadios('langRadios', 'language', LANGS);

$('provider').addEventListener('change', (e) => {
  state.provider = e.target.value;
  const info = PROVIDER_INFO[state.provider] || {};
  if (state.provider !== 'custom') {
    state.baseUrl = info.baseUrl;
    state.model = info.model;
  }
  updateProviderUi();
});

$('replyLength').addEventListener('input', (e) => {
  $('replyLengthNum').value = e.target.value;
});
$('replyLengthNum').addEventListener('input', (e) => {
  $('replyLength').value = e.target.value;
});

$('systemPrompt').addEventListener('input', (e) => {
  $('charCount').textContent = e.target.value.length;
});

$('tweetPrompt').addEventListener('input', (e) => {
  $('tweetCharCount').textContent = e.target.value.length;
});

$('promptHead').addEventListener('click', () => {
  const body = $('promptBody');
  body.hidden = !body.hidden;
  $('promptHead').classList.toggle('open', !body.hidden);
});

$('addPrompt').addEventListener('click', () => {
  const name = $('newPromptName').value.trim();
  const content = $('systemPrompt').value.trim();
  if (!name) return status('请填写提示词名称', 'err');
  if (!content) return status('系统提示词为空', 'err');
  state.prompts = state.prompts || [];
  state.prompts.push({ name, content });
  $('newPromptName').value = '';
  renderPrompts();
  chrome.storage.sync.set({ prompts: state.prompts }, () => status('已保存提示词：' + name, 'ok'));
});

$('addType').addEventListener('click', () => {
  state.tweetTypes = Array.isArray(state.tweetTypes) ? state.tweetTypes : [];
  state.tweetTypes.push({ id: 'custom_' + Date.now(), label: '新类型', hint: '', enabled: true });
  renderTypes();
  status('已添加自定义类型，填好名称和提示词后点「保存设置」', 'ok');
});

$('save').addEventListener('click', () => {
  const s = collectForm();
  chrome.storage.sync.set(s, () => status('设置已保存 ✓', 'ok'));
});

$('reset').addEventListener('click', () => {
  state = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  chrome.storage.sync.set(state, () => {
    fillForm();
    status('已重置为默认设置', 'ok');
  });
});

$('test').addEventListener('click', () => {
  const s = collectForm();
  chrome.storage.sync.set(s, () => {
    status('正在测试连接…');
    chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }, (resp) => {
      if (chrome.runtime.lastError) {
        return status('测试失败：' + chrome.runtime.lastError.message, 'err');
      }
      if (resp && resp.ok) status('连接正常 ✓ 返回：' + resp.reply, 'ok');
      else status('连接失败：' + (resp ? resp.error : '无响应'), 'err');
    });
  });
});

/* ---------- 配置导入 / 导出 ---------- */

$('exportCfg').addEventListener('click', () => {
  chrome.storage.sync.get(null, (sync) => {
    chrome.storage.local.get(null, (local) => {
      const payload = {
        app: 'quick-ai-reply',
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: sync || {},
        local: local || {} // 轮换游标 rotIdx、最近发帖记录 recentTweets
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      a.href = url;
      a.download = 'quick-ai-reply-config-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status('配置已导出 ✓（包含 API Key，请妥善保管文件）', 'ok');
    });
  });
});

$('importCfg').addEventListener('click', () => $('cfgFile').click());

$('cfgFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data = null;
    try {
      data = JSON.parse(reader.result);
    } catch (err) {
      return status('导入失败：不是有效的 JSON 文件', 'err');
    }
    if (!data || data.app !== 'quick-ai-reply' || typeof data.settings !== 'object') {
      return status('导入失败：不是本扩展导出的配置文件', 'err');
    }
    // 只收已知字段，防止写入垃圾数据
    const clean = {};
    Object.keys(DEFAULT_SETTINGS).forEach((k) => {
      if (k in data.settings) clean[k] = data.settings[k];
    });
    chrome.storage.sync.set(clean, () => {
      // 本地数据（轮换游标 / 防重复记录）一并恢复
      const localClean = {};
      ['rotIdx', 'recentTweets'].forEach((k) => {
        if (data.local && k in data.local) localClean[k] = data.local[k];
      });
      if (Object.keys(localClean).length) chrome.storage.local.set(localClean);
      chrome.storage.sync.get(DEFAULT_SETTINGS, (s) => {
        state = Object.assign({}, DEFAULT_SETTINGS, s || {});
        fillForm();
        status('配置已导入并生效 ✓（类型轮换从导入的游标继续）', 'ok');
      });
    });
  };
  reader.readAsText(file);
});

/* ---------- 初始化 ---------- */

chrome.storage.sync.get(DEFAULT_SETTINGS, (s) => {
  state = Object.assign({}, DEFAULT_SETTINGS, s || {});
  fillForm();
});
