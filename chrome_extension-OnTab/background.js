/* Author: Genisai
Source: https://github.com/Vectricity/ontab */
const STORAGE_KEY = 'suspendedTabs';
const STORAGE_SCHEMA_KEY = 'suspendedTabsSchemaVersion';
const STORAGE_SCHEMA_VERSION = 2;
const SESSION_ASSOCIATIONS_KEY = 'suspendedTabAssociations';
const SESSION_RECREATED_KEY = 'startupRecreatedSuspendedTabs';
const SETTINGS_KEY = 'settings';
const DEFAULT_PRESENTATION_SETTINGS = Object.freeze({ icon: 'original', title: 'original' });
const SUSPENDED_PAGE_URL = chrome.runtime.getURL('suspended.html');

let suspendedRecords = new Map(); 
let tabAssociations = new Map();  
let startupRecreatedTabs = new Map(); 
let presentationSettings = { ...DEFAULT_PRESENTATION_SETTINGS };
let initialized = false;
let initPromise = null;
const restoringTabs = new Set();
const supersededRecreatedTabs = new Set();

function log(...args) {
  console.log('[OnTab]', new Date().toISOString(), ...args);
}

function createSuspensionId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function isSuspensionId(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getTabUrl(tab) {
  return tab?.url || tab?.pendingUrl || '';
}

function isSuspendedUrl(url) {
  return typeof url === 'string' && (url === SUSPENDED_PAGE_URL || url.startsWith(`${SUSPENDED_PAGE_URL}#`));
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

function normalizeTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.now();
}

function normalizePresentationSettings(value) {
  const candidate = value && typeof value === 'object'
    ? (value.suspendedTabs && typeof value.suspendedTabs === 'object' ? value.suspendedTabs : value)
    : {};

  return {
    icon: candidate.icon === 'ontab' ? 'ontab' : 'original',
    title: candidate.title === 'pause' || candidate.title === 'ontab' ? candidate.title : 'original'
  };
}

function serializePresentationSettings(value) {
  return { suspendedTabs: normalizePresentationSettings(value) };
}

function normalizeRecord(id, source = {}, fallback = {}, indexOverride) {
  const url = typeof source.url === 'string' && source.url
    ? source.url
    : (typeof fallback.url === 'string' ? fallback.url : '');

  if (!url) return null;

  const title = typeof source.title === 'string'
    ? source.title
    : (typeof fallback.title === 'string' ? fallback.title : 'Suspended Tab');

  const favIconUrl = typeof source.favIconUrl === 'string'
    ? source.favIconUrl
    : (typeof fallback.favIconUrl === 'string' ? fallback.favIconUrl : '');

  const sourceIndex = Number.isInteger(source.index) ? source.index : fallback.index;
  const index = Number.isInteger(indexOverride)
    ? indexOverride
    : (Number.isInteger(sourceIndex) ? sourceIndex : undefined);

  const record = {
    id,
    url,
    title: title || 'Suspended Tab',
    favIconUrl,
    suspendedAt: normalizeTimestamp(source.suspendedAt ?? fallback.suspendedAt)
  };

  if (Number.isInteger(index)) record.index = index;
  return record;
}

function parseSuspendedUrl(url) {
  if (!isSuspendedUrl(url)) return null;

  try {
    const hash = url.split('#')[1] || '';
    const params = new URLSearchParams(hash);
    const originalUrl = params.get('u') || '';

    return {
      id: params.get('id') || '',
      url: originalUrl,
      title: params.get('t') || 'Suspended Tab',
      suspendedAt: normalizeTimestamp(params.get('s')),
      favIconUrl: params.get('f') || ''
    };
  } catch (error) {
    log('parseSuspendedUrl ERROR:', error);
    return null;
  }
}

function buildSuspendedUrl(id, record) {
  const params = new URLSearchParams();
  params.set('id', id);
  params.set('u', record.url);
  params.set('t', record.title || 'Suspended Tab');
  params.set('s', String(record.suspendedAt || Date.now()));
  if (record.favIconUrl) params.set('f', record.favIconUrl);
  params.set('icon', presentationSettings.icon);
  params.set('titleMode', presentationSettings.title);
  return `${SUSPENDED_PAGE_URL}#${params.toString()}`;
}

async function loadPersistentState() {
  const data = await chrome.storage.local.get([STORAGE_KEY, STORAGE_SCHEMA_KEY, SETTINGS_KEY]);
  const raw = data[STORAGE_KEY] || {};
  const records = new Map();
  const legacy = new Map();

  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || typeof value.url !== 'string' || !value.url) continue;

    if (isSuspensionId(key)) {
      const normalized = normalizeRecord(key, value);
      if (normalized) records.set(key, normalized);
    } else {
      
      
      legacy.set(key, value);
    }
  }

  log(
    'loadPersistentState:',
    records.size,
    'UUID records,',
    legacy.size,
    'legacy records, schema',
    data[STORAGE_SCHEMA_KEY] ?? 1
  );

  return {
    records,
    legacy,
    settings: normalizePresentationSettings(data[SETTINGS_KEY])
  };
}

async function loadSessionState() {
  if (!chrome.storage.session) {
    return { associations: new Map(), recreated: new Map() };
  }

  try {
    const data = await chrome.storage.session.get([
      SESSION_ASSOCIATIONS_KEY,
      SESSION_RECREATED_KEY
    ]);

    const associations = new Map();
    const recreated = new Map();

    for (const [tabIdText, suspensionId] of Object.entries(data[SESSION_ASSOCIATIONS_KEY] || {})) {
      const tabId = Number(tabIdText);
      if (Number.isInteger(tabId) && isSuspensionId(suspensionId)) {
        associations.set(tabId, suspensionId);
      }
    }

    for (const [tabIdText, suspensionId] of Object.entries(data[SESSION_RECREATED_KEY] || {})) {
      const tabId = Number(tabIdText);
      if (Number.isInteger(tabId) && isSuspensionId(suspensionId)) {
        recreated.set(tabId, suspensionId);
      }
    }

    return { associations, recreated };
  } catch (error) {
    log('loadSessionState ERROR:', error);
    return { associations: new Map(), recreated: new Map() };
  }
}

async function savePersistentState() {
  const object = Object.fromEntries(suspendedRecords);
  await chrome.storage.local.set({
    [STORAGE_KEY]: object,
    [STORAGE_SCHEMA_KEY]: STORAGE_SCHEMA_VERSION
  });
}

async function saveSessionAssociations() {
  if (!chrome.storage.session) return;

  try {
    await chrome.storage.session.set({
      [SESSION_ASSOCIATIONS_KEY]: Object.fromEntries(tabAssociations),
      [SESSION_RECREATED_KEY]: Object.fromEntries(startupRecreatedTabs)
    });
  } catch (error) {
    log('saveSessionAssociations ERROR:', error);
  }
}

function buildQueueByUrl(entries) {
  const byUrl = new Map();

  for (const [key, value] of entries) {
    if (!value?.url) continue;
    if (!byUrl.has(value.url)) byUrl.set(value.url, []);
    byUrl.get(value.url).push(key);
  }

  return byUrl;
}

function takeQueuedEntry(queueByUrl, backingMap, url) {
  const queue = queueByUrl.get(url);
  if (!queue) return null;

  while (queue.length) {
    const key = queue.shift();
    if (!backingMap.has(key)) continue;
    const value = backingMap.get(key);
    backingMap.delete(key);
    return [key, value];
  }

  return null;
}

async function rewriteSuspendedTab(tabId, id, record) {
  const canonicalUrl = buildSuspendedUrl(id, record);
  try {
    await chrome.tabs.update(tabId, { url: canonicalUrl });
  } catch (error) {
    log('rewriteSuspendedTab ERROR for tab', tabId, ':', error);
  }
}

async function reconcileSuspendedTabs(legacyRecords) {
  const allTabs = await chrome.tabs.query({});
  
  
  
  
  

  const existingSuspended = allTabs.filter(tab => Number.isInteger(tab.id) && isSuspendedUrl(getTabUrl(tab)));
  const withIds = [];
  const withoutIds = [];

  for (const tab of existingSuspended) {
    const metadata = parseSuspendedUrl(getTabUrl(tab));
    if (metadata && isSuspensionId(metadata.id)) withIds.push([tab, metadata]);
    else withoutIds.push([tab, metadata]);
  }

  const associatedIds = new Set();

  
  for (const [tab, metadata] of withIds) {
    let id = metadata.id;
    let record = normalizeRecord(id, suspendedRecords.get(id) || {}, metadata, tab.index);

    if (!record) {
      log('reconcile: suspended tab', tab.id, 'has no recoverable original URL; leaving it untouched');
      continue;
    }

    if (associatedIds.has(id)) {
      
      
      const previousId = id;
      id = createSuspensionId();
      record = normalizeRecord(id, record, metadata, tab.index);
      suspendedRecords.set(id, record);
      tabAssociations.set(tab.id, id);
      associatedIds.add(id);
        await rewriteSuspendedTab(tab.id, id, record);
      log('reconcile: duplicate suspension ID', previousId, 'on tab', tab.id, 'migrated to', id);
      continue;
    }

    suspendedRecords.set(id, record);
    tabAssociations.set(tab.id, id);
    associatedIds.add(id);

    const canonicalUrl = buildSuspendedUrl(id, record);
    if (getTabUrl(tab) !== canonicalUrl) {
      await rewriteSuspendedTab(tab.id, id, record);
    }
  }

  
  
  
  const legacyByUrl = buildQueueByUrl(legacyRecords);
  const availableV2 = new Map(
    [...suspendedRecords].filter(([id]) => !associatedIds.has(id))
  );
  const availableV2ByUrl = buildQueueByUrl(availableV2);

  for (const [tab, metadata] of withoutIds) {
    if (!metadata?.url) {
      log('reconcile: malformed suspended tab', tab.id, 'left intact for recovery');
      continue;
    }

    let id = '';
    let sourceRecord = null;

    
    
    
    const exactLegacyKey = String(tab.id);
    const exactLegacy = legacyRecords.get(exactLegacyKey);
    if (exactLegacy?.url === metadata.url) {
      sourceRecord = exactLegacy;
      legacyRecords.delete(exactLegacyKey);
    } else {
      const queuedLegacy = takeQueuedEntry(legacyByUrl, legacyRecords, metadata.url);
      if (queuedLegacy) sourceRecord = queuedLegacy[1];
    }

    if (!sourceRecord) {
      const queuedV2 = takeQueuedEntry(availableV2ByUrl, availableV2, metadata.url);
      if (queuedV2) {
        id = queuedV2[0];
        sourceRecord = queuedV2[1];
      }
    }

    if (!id) id = createSuspensionId();
    const record = normalizeRecord(id, sourceRecord || {}, metadata, tab.index);

    if (!record) {
      log('reconcile: could not migrate tab', tab.id, '; leaving it intact');
      continue;
    }

    suspendedRecords.set(id, record);
    tabAssociations.set(tab.id, id);
    associatedIds.add(id);
    await rewriteSuspendedTab(tab.id, id, record);
    log('reconcile: migrated legacy suspended tab', tab.id, 'to', id);
  }

  
  
  
  for (const [, legacyRecord] of legacyRecords) {
    const id = createSuspensionId();
    const record = normalizeRecord(id, legacyRecord);
    if (record) suspendedRecords.set(id, record);
  }

  await savePersistentState();
  await saveSessionAssociations();
  log('reconcile: complete with', suspendedRecords.size, 'records and', tabAssociations.size, 'live associations');
}

async function initialize() {
  const [{ records, legacy, settings }, sessionState] = await Promise.all([
    loadPersistentState(),
    loadSessionState()
  ]);

  suspendedRecords = records;
  tabAssociations = sessionState.associations;
  startupRecreatedTabs = sessionState.recreated;
  presentationSettings = settings;
  await chrome.storage.local.set({ [SETTINGS_KEY]: serializePresentationSettings(presentationSettings) });
  await reconcileSuspendedTabs(legacy);
}

async function ensureInitialized() {
  if (initialized) return;

  if (!initPromise) {
    initPromise = initialize()
      .then(() => {
        initialized = true;
        log('initialization complete');
      })
      .catch(error => {
        initPromise = null;
        log('initialization ERROR:', error);
        throw error;
      });
  }

  await initPromise;
}

function getAssociatedTabId(suspensionId) {
  for (const [tabId, id] of tabAssociations) {
    if (id === suspensionId) return tabId;
  }
  return null;
}

async function associateSuspendedTab(tab) {
  if (!Number.isInteger(tab?.id)) return null;

  const tabUrl = getTabUrl(tab);
  const metadata = parseSuspendedUrl(tabUrl);
  if (!metadata?.url) return null;

  let id = isSuspensionId(metadata.id) ? metadata.id : '';
  let record = id ? suspendedRecords.get(id) : null;

  if (id) {
    const otherTabId = getAssociatedTabId(id);
    if (otherTabId !== null && otherTabId !== tab.id) {
      if (startupRecreatedTabs.get(otherTabId) === id) {
        
        
        
        
        tabAssociations.delete(otherTabId);
        startupRecreatedTabs.delete(otherTabId);
        supersededRecreatedTabs.add(otherTabId);
        try {
          await chrome.tabs.remove(otherTabId);
        } catch (error) {
          log('associateSuspendedTab: failed to remove startup duplicate', otherTabId, error);
          supersededRecreatedTabs.delete(otherTabId);
        }
      } else {
        
        id = createSuspensionId();
        record = null;
      }
    }
  }

  if (!id) {
    
    
    
    const recreatedMatch = [...startupRecreatedTabs.entries()].find(
      ([, candidateId]) => suspendedRecords.get(candidateId)?.url === metadata.url
    );

    if (recreatedMatch) {
      const [recreatedTabId, candidateId] = recreatedMatch;
      id = candidateId;
      record = suspendedRecords.get(id) || null;
      tabAssociations.delete(recreatedTabId);
      startupRecreatedTabs.delete(recreatedTabId);
      supersededRecreatedTabs.add(recreatedTabId);

      try {
        await chrome.tabs.remove(recreatedTabId);
      } catch (error) {
        log('associateSuspendedTab: failed to remove legacy startup duplicate', recreatedTabId, error);
        supersededRecreatedTabs.delete(recreatedTabId);
      }
    } else {
      
      const liveIds = new Set(tabAssociations.values());
      const detachedMatch = [...suspendedRecords.entries()].find(
        ([candidateId, candidate]) => !liveIds.has(candidateId) && candidate?.url === metadata.url
      );

      if (detachedMatch) {
        [id, record] = detachedMatch;
      } else {
        id = createSuspensionId();
      }
    }
  }

  record = normalizeRecord(id, record || {}, metadata, tab.index);
  if (!record) return null;

  suspendedRecords.set(id, record);
  tabAssociations.set(tab.id, id);
  await Promise.all([savePersistentState(), saveSessionAssociations()]);

  if (metadata.id !== id) {
    await rewriteSuspendedTab(tab.id, id, record);
  }

  return { id, record };
}

async function recreateMissingSuspendedTabs() {
  await ensureInitialized();

  const liveIds = new Set(tabAssociations.values());
  const missing = [...suspendedRecords.entries()]
    .filter(([id, record]) => !liveIds.has(id) && record?.url)
    .sort((a, b) => (a[1].index ?? Number.MAX_SAFE_INTEGER) - (b[1].index ?? Number.MAX_SAFE_INTEGER));

  for (const [id, record] of missing) {
    
    
    if (getAssociatedTabId(id) !== null) continue;

    const createProperties = {
      url: buildSuspendedUrl(id, record),
      active: false
    };
    if (Number.isInteger(record.index)) createProperties.index = record.index;

    try {
      const newTab = await chrome.tabs.create(createProperties);
      if (!Number.isInteger(newTab.id)) continue;

      suspendedRecords.set(id, normalizeRecord(id, record, {}, newTab.index));
      tabAssociations.set(newTab.id, id);
      startupRecreatedTabs.set(newTab.id, id);
      liveIds.add(id);
      log('startup recovery: recreated suspended tab', newTab.id, 'for', id);
    } catch (error) {
      log('startup recovery: failed to recreate', id, ':', error);
    }
  }

  await Promise.all([savePersistentState(), saveSessionAssociations()]);
}

async function suspendTab(tabId) {
  await ensureInitialized();

  const tab = await chrome.tabs.get(tabId);
  const tabUrl = getTabUrl(tab);

  if (isSuspendedUrl(tabUrl)) {
    await associateSuspendedTab(tab);
    return { success: true, alreadySuspended: true };
  }

  if (!canSuspend(tabUrl)) {
    return { success: false, error: 'This page cannot be suspended.' };
  }

  const id = createSuspensionId();
  const record = normalizeRecord(id, {
    url: tabUrl,
    title: tab.title || 'Suspended Tab',
    favIconUrl: tab.favIconUrl || '',
    suspendedAt: Date.now(),
    index: tab.index
  });

  if (!record) return { success: false, error: 'The tab URL could not be saved.' };

  suspendedRecords.set(id, record);
  tabAssociations.set(tabId, id);

  try {
    await chrome.tabs.update(tabId, { url: buildSuspendedUrl(id, record) });
    await Promise.all([savePersistentState(), saveSessionAssociations()]);
    return { success: true };
  } catch (error) {
    suspendedRecords.delete(id);
    tabAssociations.delete(tabId);
    await saveSessionAssociations();
    log('suspendTab ERROR for', tabId, ':', error);
    return { success: false, error: 'OnTab could not suspend this tab.' };
  }
}

async function resolveSuspendedRecord(tab) {
  if (!Number.isInteger(tab?.id)) return null;

  const associatedId = tabAssociations.get(tab.id);
  if (associatedId) {
    const associatedRecord = suspendedRecords.get(associatedId);
    if (associatedRecord?.url) return { id: associatedId, record: associatedRecord };
  }

  return associateSuspendedTab(tab);
}

async function restoreTab(tabId) {
  await ensureInitialized();

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    return { success: false, error: 'The suspended tab no longer exists.' };
  }

  if (!isSuspendedUrl(getTabUrl(tab))) {
    return { success: false, error: 'This tab is not suspended by OnTab.' };
  }

  const resolved = await resolveSuspendedRecord(tab);
  const record = resolved?.record;
  const id = resolved?.id;

  if (!record?.url || !id) {
    
    const metadata = parseSuspendedUrl(getTabUrl(tab));
    if (!metadata?.url) {
      return { success: false, error: 'The original URL is missing from this suspended tab.' };
    }

    try {
      await chrome.tabs.update(tabId, { url: metadata.url });
      return { success: true, recoveredFromPage: true };
    } catch (error) {
      log('restoreTab fallback ERROR for', tabId, ':', error);
      return { success: false, error: 'OnTab could not restore the original page.' };
    }
  }

  restoringTabs.add(tabId);
  try {
    await chrome.tabs.update(tabId, { url: record.url });

    
    suspendedRecords.delete(id);
    tabAssociations.delete(tabId);
    startupRecreatedTabs.delete(tabId);
    await Promise.all([savePersistentState(), saveSessionAssociations()]);
    return { success: true };
  } catch (error) {
    log('restoreTab ERROR for', tabId, ':', error);
    return { success: false, error: 'OnTab could not restore the original page.' };
  } finally {
    restoringTabs.delete(tabId);
  }
}

async function restoreAllTabs() {
  await ensureInitialized();

  const tabs = await chrome.tabs.query({});
  const suspendedTabs = tabs.filter(tab => Number.isInteger(tab.id) && isSuspendedUrl(getTabUrl(tab)));
  let restored = 0;
  let failed = 0;

  for (const tab of suspendedTabs) {
    const result = await restoreTab(tab.id);
    if (result?.success) restored += 1;
    else failed += 1;
  }

  return { success: failed === 0, restored, failed, total: suspendedTabs.length };
}

async function removeSuspensionForTab(tabId) {
  const id = tabAssociations.get(tabId);
  if (!id) return;

  tabAssociations.delete(tabId);
  startupRecreatedTabs.delete(tabId);
  suspendedRecords.delete(id);
  await Promise.all([savePersistentState(), saveSessionAssociations()]);
}

async function applyPresentationSettingsToLiveTabs() {
  const allTabs = await chrome.tabs.query({});

  for (const tab of allTabs) {
    if (!Number.isInteger(tab.id) || !isSuspendedUrl(getTabUrl(tab)) || restoringTabs.has(tab.id)) continue;

    const resolved = await resolveSuspendedRecord(tab);
    if (!resolved?.id || !resolved.record?.url) continue;

    const nextUrl = buildSuspendedUrl(resolved.id, resolved.record);
    if (getTabUrl(tab) === nextUrl) continue;

    try {
      const currentTab = await chrome.tabs.get(tab.id);
      if (!isSuspendedUrl(getTabUrl(currentTab)) || restoringTabs.has(tab.id)) continue;
      await chrome.tabs.update(tab.id, { url: nextUrl });
    } catch (error) {
      log('presentation update ERROR for tab', tab.id, ':', error);
    }
  }
}

async function setPresentationSettings(value) {
  const next = normalizePresentationSettings(value);
  presentationSettings = next;
  await chrome.storage.local.set({ [SETTINGS_KEY]: serializePresentationSettings(next) });
  await applyPresentationSettingsToLiveTabs();
  return { success: true, settings: { ...presentationSettings } };
}

function removeAllContextMenus() {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.removeAll(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

async function createContextMenus() {
  await removeAllContextMenus();

  chrome.contextMenus.create({
    id: 'suspendTab',
    title: 'Suspend Tab',
    contexts: ['tab']
  });
  chrome.contextMenus.create({
    id: 'restoreTab',
    title: 'Restore Tab',
    contexts: ['tab']
  });
  chrome.contextMenus.create({
    id: 'suspendPage',
    title: 'Suspend This Tab',
    contexts: ['page', 'frame']
  });
  chrome.contextMenus.create({
    id: 'restorePage',
    title: 'Restore This Tab',
    contexts: ['page', 'frame']
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  void createContextMenus().catch(error => log('context menu setup ERROR:', error));

  void (async () => {
    await ensureInitialized();

    
    
    
    
    if (details?.reason === 'update') {
      await recreateMissingSuspendedTabs();
    }
  })().catch(error => log('install/update recovery ERROR:', error));
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureInitialized();
    await recreateMissingSuspendedTabs();
  })().catch(error => log('startup recovery ERROR:', error));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!Number.isInteger(tab?.id)) return;

  void (async () => {
    await ensureInitialized();
    const suspended = isSuspendedUrl(getTabUrl(tab));

    if (info.menuItemId === 'suspendTab' || info.menuItemId === 'suspendPage') {
      if (!suspended) await suspendTab(tab.id);
    } else if (info.menuItemId === 'restoreTab' || info.menuItemId === 'restorePage') {
      if (suspended) await restoreTab(tab.id);
    }
  })().catch(error => log('context menu action ERROR:', error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  let operation = null;

  if (message.type === 'restore' && Number.isInteger(sender.tab?.id)) {
    operation = restoreTab(sender.tab.id);
  } else if (message.type === 'restoreTab' && Number.isInteger(message.tabId)) {
    operation = restoreTab(message.tabId);
  } else if (message.type === 'suspendTab' && Number.isInteger(message.tabId)) {
    operation = suspendTab(message.tabId);
  } else if (message.type === 'restoreAllTabs') {
    operation = restoreAllTabs();
  } else if (message.type === 'getActiveTab') {
    operation = chrome.tabs.query({ active: true, currentWindow: true })
      .then(tabs => ({ success: true, tab: tabs[0] || null }));
  } else if (message.type === 'getPresentationSettings') {
    operation = ensureInitialized()
      .then(() => ({ success: true, settings: { ...presentationSettings } }));
  } else if (message.type === 'setPresentationSettings') {
    operation = ensureInitialized()
      .then(() => setPresentationSettings(message.settings));
  }

  if (!operation) return false;

  void operation
    .then(result => sendResponse(result || { success: true }))
    .catch(error => {
      log('message operation ERROR:', error);
      sendResponse({ success: false, error: 'OnTab encountered an unexpected error.' });
    });

  return true;
});

chrome.tabs.onCreated.addListener(tab => {
  void (async () => {
    await ensureInitialized();
    if (isSuspendedUrl(getTabUrl(tab))) await associateSuspendedTab(tab);
  })().catch(error => log('onCreated ERROR:', error));
});

chrome.tabs.onRemoved.addListener(tabId => {
  void (async () => {
    await ensureInitialized();

    if (supersededRecreatedTabs.delete(tabId)) {
      await saveSessionAssociations();
      return;
    }

    await removeSuspensionForTab(tabId);
  })().catch(error => log('onRemoved ERROR:', error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;

  void (async () => {
    await ensureInitialized();

    if (isSuspendedUrl(changeInfo.url)) {
      await associateSuspendedTab({ ...tab, id: tabId, url: changeInfo.url });
      return;
    }

    if (!restoringTabs.has(tabId) && tabAssociations.has(tabId)) {
      await removeSuspensionForTab(tabId);
    }
  })().catch(error => log('onUpdated ERROR:', error));
});

log('background.js loaded');
