/* Quick AI Reply for X.com - popup 脚本 */

const DEFAULTS = { apiKey: '', provider: 'deepseek', model: 'deepseek-chat' };

function setStatus(text, cls) {
  document.getElementById('status').textContent = text;
  const dot = document.getElementById('dot');
  dot.className = 'dot ' + (cls || '');
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  if (s.apiKey) {
    setStatus(
      '已配置 API Key（模型：' + (s.model || s.provider) + '），可以开始使用。',
      'ok'
    );
  } else {
    setStatus('尚未配置 API Key，请先打开设置填写后再使用。', 'err');
  }
});

document.getElementById('openSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// 显示当前标签页是否为 X
if (chrome.tabs && chrome.tabs.query) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const t = tabs && tabs[0];
    const el = document.getElementById('currentTab');
    if (t && /(^https?:\/\/(x|twitter)\.com\/)/.test(t.url || '')) {
      el.textContent = '当前页面：X ✓ 在帖子下方点击 Reply 或 AI 按钮即可';
    } else if (t) {
      el.textContent = '提示：请在 x.com 页面使用本扩展。';
    }
  });
}
