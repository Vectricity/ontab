/* Author: Genisai
Source: https://github.com/Vectricity/ontab */
(function() {
  let currentTab = null;
  const suspendedPageUrl = chrome.runtime.getURL('suspended.html');
  const defaultSettings = { icon: 'original', title: 'original' };
  const mainView = document.getElementById('mainView');
  const settingsView = document.getElementById('settingsView');
  const settingsButton = document.getElementById('settingsButton');
  const backButton = document.getElementById('backButton');
  const headerTitle = document.getElementById('headerTitle');
  const iconSetting = document.getElementById('iconSetting');
  const titleSetting = document.getElementById('titleSetting');
  const restoreAllButton = document.getElementById('restoreAllButton');

  function isSuspendedUrl(url) {
    return typeof url === 'string' && (url === suspendedPageUrl || url.startsWith(suspendedPageUrl + '#'));
  }

  async function load() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs[0];
    renderCurrentTab();
    await renderSuspendedTabs();
    await loadSettings();
  }

  function renderCurrentTab() {
    const titleEl = document.getElementById('currentTitle');
    const urlEl = document.getElementById('currentUrl');
    const actionsEl = document.getElementById('currentActions');

    if (!currentTab) {
      titleEl.textContent = 'No active tab';
      urlEl.textContent = '—';
      actionsEl.innerHTML = '';
      return;
    }

    const suspended = isSuspendedUrl(currentTab.url);

    if (suspended) {
      const params = new URLSearchParams((currentTab.url.split('#')[1] || ''));
      titleEl.textContent = params.get('t') || currentTab.title || 'Suspended Tab';
      urlEl.textContent = params.get('u') || currentTab.url || '—';
    } else {
      titleEl.textContent = currentTab.title || 'Untitled';
      urlEl.textContent = currentTab.url || '—';
    }

    actionsEl.innerHTML = '';

    if (suspended) {
      const btn = document.createElement('button');
      btn.className = 'btn-restore';
      btn.textContent = 'Restore Tab';
      btn.addEventListener('click', () => {
        void chrome.runtime.sendMessage({ type: 'restoreTab', tabId: currentTab.id });
        window.close();
      });
      actionsEl.appendChild(btn);
    } else if (canSuspend(currentTab.url)) {
      const btn = document.createElement('button');
      btn.className = 'btn-suspend';
      btn.textContent = 'Suspend Tab';
      btn.addEventListener('click', () => {
        void chrome.runtime.sendMessage({ type: 'suspendTab', tabId: currentTab.id });
        window.close();
      });
      actionsEl.appendChild(btn);
    } else {
      const cannotSuspend = document.createElement('span');
      cannotSuspend.className = 'cannot-suspend';
      cannotSuspend.textContent = 'Cannot suspend';
      actionsEl.appendChild(cannotSuspend);
    }
  }

  function canSuspend(url) {
    return Boolean(url) &&
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('edge://') &&
      !url.startsWith('about:') &&
      !url.startsWith('data:') &&
      !url.startsWith('blob:');
  }

  async function renderSuspendedTabs() {
    const list = document.getElementById('suspendedList');
    const tabs = await chrome.tabs.query({});
    const suspendedTabs = tabs.filter(tab => isSuspendedUrl(tab.url));

    if (suspendedTabs.length === 0) {
      list.innerHTML = '<div class="empty">No suspended tabs</div>';
      return;
    }

    list.innerHTML = '';

    for (const tab of suspendedTabs) {
      const params = new URLSearchParams(tab.url.split('#')[1] || '');
      const originalUrl = params.get('u') || tab.url;
      const originalTitle = params.get('t') || tab.title;

      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <div class="item-info">
          <div class="item-title">${escapeHtml(originalTitle)}</div>
          <div class="item-url">${escapeHtml(originalUrl)}</div>
        </div>
        <div class="item-actions">
          <button class="btn-restore" data-tab-id="${tab.id}">Restore</button>
        </div>
      `;
      list.appendChild(div);
    }

    list.querySelectorAll('.btn-restore').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = Number(btn.dataset.tabId);
        if (Number.isInteger(tabId)) {
          void chrome.runtime.sendMessage({ type: 'restoreTab', tabId });
        }
        window.close();
      });
    });
  }

  function normalizeSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      icon: source.icon === 'ontab' ? 'ontab' : 'original',
      title: source.title === 'pause' || source.title === 'ontab' ? source.title : 'original'
    };
  }

  async function loadSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'getPresentationSettings' });
      const settings = response?.success ? normalizeSettings(response.settings) : defaultSettings;
      iconSetting.value = settings.icon;
      titleSetting.value = settings.title;
    } catch (error) {
      iconSetting.value = defaultSettings.icon;
      titleSetting.value = defaultSettings.title;
    }
  }

  async function saveSettings() {
    const next = normalizeSettings({ icon: iconSetting.value, title: titleSetting.value });
    iconSetting.disabled = true;
    titleSetting.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({ type: 'setPresentationSettings', settings: next });
      if (!response?.success) throw new Error(response?.error || 'Settings could not be saved.');
      const saved = normalizeSettings(response.settings);
      iconSetting.value = saved.icon;
      titleSetting.value = saved.title;
    } catch (error) {
      await loadSettings();
    } finally {
      iconSetting.disabled = false;
      titleSetting.disabled = false;
    }
  }

  async function restoreAllTabs() {
    restoreAllButton.disabled = true;
    restoreAllButton.textContent = 'Restoring…';

    try {
      const response = await chrome.runtime.sendMessage({ type: 'restoreAllTabs' });
      if (!response?.success) throw new Error(response?.error || 'Tabs could not be restored.');
      window.close();
    } catch (error) {
      restoreAllButton.disabled = false;
      restoreAllButton.textContent = 'Restore All Tabs';
    }
  }

  function openSettings() {
    mainView.hidden = true;
    settingsView.hidden = false;
    settingsButton.hidden = true;
    backButton.hidden = false;
    headerTitle.textContent = 'Settings';
    document.body.classList.add('settings-open');
  }

  function closeSettings() {
    settingsView.hidden = true;
    mainView.hidden = false;
    backButton.hidden = true;
    settingsButton.hidden = false;
    headerTitle.textContent = 'OnTab';
    document.body.classList.remove('settings-open');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  settingsButton.addEventListener('click', openSettings);
  backButton.addEventListener('click', closeSettings);
  iconSetting.addEventListener('change', () => { void saveSettings(); });
  titleSetting.addEventListener('change', () => { void saveSettings(); });
  restoreAllButton.addEventListener('click', () => { void restoreAllTabs(); });

  void load();
})();
