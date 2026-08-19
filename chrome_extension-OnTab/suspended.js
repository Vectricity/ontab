/* Author: Genisai
Source: https://github.com/Vectricity/ontab */
(function() {
  const fallbackCardFavicon = chrome.runtime.getURL('assets/globe.png');
  const transparentTabFavicon = chrome.runtime.getURL('icons/tab-placeholder-16.png');
  const onTabFavicon = chrome.runtime.getURL('icons/icon-32.png');

  function getParams() {
    return new URLSearchParams(location.hash.slice(1));
  }

  function getStoredOrChromeFavicon(originalUrl, storedFaviconUrl) {
    if (storedFaviconUrl) return storedFaviconUrl;
    if (!originalUrl) return '';
    const url = new URL(chrome.runtime.getURL('_favicon/'));
    url.searchParams.set('pageUrl', originalUrl);
    url.searchParams.set('size', '32');
    return url.toString();
  }

  function getChromeFavicon(originalUrl) {
    if (!originalUrl) return '';
    const url = new URL(chrome.runtime.getURL('_favicon/'));
    url.searchParams.set('pageUrl', originalUrl);
    url.searchParams.set('size', '32');
    return url.toString();
  }

  function setFaviconWithFallback(element, candidates) {
    const queue = [...new Set(candidates.filter(Boolean))];
    let index = 0;

    element.onerror = function() {
      if (index < queue.length) element.href = queue[index++];
    };

    if (queue.length) element.href = queue[index++];
  }

  function setImageWithFallback(element, candidates) {
    const queue = [...new Set(candidates.filter(Boolean))];
    let index = 0;

    element.onerror = function() {
      if (index < queue.length) element.src = queue[index++];
    };

    if (queue.length) element.src = queue[index++];
  }

  function getTitle(originalTitle, mode) {
    if (mode === 'pause') return '⏸ ' + originalTitle;
    if (mode === 'ontab') return 'OnTab — ' + originalTitle;
    return originalTitle;
  }

  function applyTabPresentation() {
    const params = getParams();
    const originalUrl = params.get('u') || '';
    const originalTitle = params.get('t') || 'Suspended Tab';
    const storedFaviconUrl = params.get('f') || '';
    const iconMode = params.get('icon') === 'ontab' ? 'ontab' : 'original';
    const titleMode = params.get('titleMode') === 'pause' || params.get('titleMode') === 'ontab'
      ? params.get('titleMode')
      : 'original';
    const pageFavicon = document.getElementById('pageFavicon');
    document.title = getTitle(originalTitle, titleMode);
    if (pageFavicon) {
      if (iconMode === 'ontab') {
        setFaviconWithFallback(pageFavicon, [onTabFavicon, transparentTabFavicon]);
      } else {
        setFaviconWithFallback(pageFavicon, [
          storedFaviconUrl,
          getChromeFavicon(originalUrl),
          transparentTabFavicon
        ]);
      }
    }
  }

  function formatSuspendedTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const wasYesterday = date.getFullYear() === yesterday.getFullYear()
      && date.getMonth() === yesterday.getMonth()
      && date.getDate() === yesterday.getDate();

    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return 'Today at ' + time;
    if (wasYesterday) return 'Yesterday at ' + time;

    return date.toLocaleDateString([], {
      month: 'long',
      day: 'numeric',
      year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric'
    }) + ' at ' + time;
  }

  function initializePage() {
    try {
      const params = getParams();
      const originalUrl = params.get('u') || '';
      const originalTitle = params.get('t') || 'Suspended Tab';
      const storedFaviconUrl = params.get('f') || '';
      const suspendedAtValue = Number(params.get('s'));
      const suspendedAt = Number.isFinite(suspendedAtValue) && suspendedAtValue > 0
        ? suspendedAtValue
        : Date.now();

      const titleEl = document.getElementById('title');
      const urlEl = document.getElementById('url');
      const metaEl = document.getElementById('meta');
      const restoreBtn = document.getElementById('restoreBtn');
      const faviconImg = document.getElementById('favicon');
      const originalFavicon = getStoredOrChromeFavicon(originalUrl, storedFaviconUrl);

      titleEl.textContent = originalTitle;
      urlEl.textContent = originalUrl || 'Original URL unavailable';
      urlEl.title = originalUrl;
      if (originalUrl) {
        urlEl.href = originalUrl;
        urlEl.setAttribute('aria-label', 'Open original page: ' + originalTitle);
      } else {
        urlEl.removeAttribute('href');
        urlEl.setAttribute('aria-disabled', 'true');
      }
      metaEl.textContent = formatSuspendedTime(suspendedAt);

      setImageWithFallback(faviconImg, [
        originalFavicon,
        getChromeFavicon(originalUrl),
        fallbackCardFavicon
      ]);

      if (!originalUrl) {
        restoreBtn.disabled = true;
        restoreBtn.querySelector('span').textContent = 'URL UNAVAILABLE';
        metaEl.textContent = 'OnTab could not recover the original URL.';
        return;
      }

      restoreBtn.addEventListener('click', async function() {
        const label = restoreBtn.querySelector('span');
        restoreBtn.disabled = true;
        label.textContent = 'RESTORING…';

        try {
          const response = await chrome.runtime.sendMessage({ type: 'restore' });
          if (!response?.success) {
            restoreBtn.disabled = false;
            label.textContent = 'RESTORE TAB';
            metaEl.textContent = response?.error || 'OnTab could not restore this tab.';
          }
        } catch (error) {
          console.error('[OnTab] restore error:', error);
          restoreBtn.disabled = false;
          label.textContent = 'RESTORE TAB';
          metaEl.textContent = 'OnTab could not restore this tab.';
        }
      });
    } catch (error) {
      console.error('[OnTab] suspended.js error:', error);
      const urlEl = document.getElementById('url');
      if (urlEl) urlEl.textContent = 'Error loading suspended tab data';
    }
  }

  applyTabPresentation();
  window.addEventListener('hashchange', applyTabPresentation);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializePage, { once: true });
  } else {
    initializePage();
  }
})();
