/**
 * Content Script
 * Handles DOM stabilization and scroll capture for full-page screenshots
 */

const DEBUG = false;

function log(...args) {
  if (DEBUG) console.log('[ContentScript]', ...args);
}

function error(...args) {
  console.error('[ContentScript]', ...args);
}

// Cache the scrollable element once found
let cachedScrollableElement = null;

// ============================================================================
// SITE HANDLERS - Special handling for specific websites
// ============================================================================

/**
 * Jira Site Handler
 * Detects Jira Server, Data Center, and Cloud instances and handles their unique scroll behavior
 */
const JiraHandler = {
  name: 'Jira',

  /**
   * Detect if the current page is a Jira issue page
   * Works for Server, Data Center, and Cloud
   */
  detect() {
    // Method 1: Jira Cloud - ALWAYS hosted on *.atlassian.net
    const isJiraCloud = (
      window.location.hostname.endsWith('.atlassian.net') &&
      window.location.pathname.match(/\/browse\/[A-Z]+-\d+/)
    );

    if (isJiraCloud) {
      return { type: 'jira-cloud', detected: true };
    }

    // Method 2: Jira Server/Data Center - self-hosted, detect by DOM
    const isJiraServer = !!(
      document.getElementById('issue-content') &&
      document.querySelector('.issue-view') &&
      document.querySelector('.aui-page-panel')
    );

    if (isJiraServer) {
      return { type: 'jira-server', detected: true };
    }

    // Method 3: Fallback - check for Jira markers (meta tags, globals)
    const hasJiraMeta = !!(
      document.querySelector('meta[name="application-name"][content*="JIRA"]') ||
      document.querySelector('meta[name="application-name"][content*="Jira"]') ||
      window.JIRA ||
      window.AJS?.Meta?.get('issue-key')
    );

    if (hasJiraMeta) {
      return { type: 'jira-unknown', detected: true };
    }

    return { detected: false };
  },

  /**
   * Find the scroll container for Jira pages
   */
  findScrollContainer() {
    const detection = this.detect();

    if (!detection.detected) {
      return null;
    }

    log(`Jira detected: ${detection.type}`);

    if (detection.type === 'jira-server') {
      return this.findServerScrollContainer();
    }

    if (detection.type === 'jira-cloud') {
      return this.findCloudScrollContainer();
    }

    // For unknown Jira type, try both methods
    return this.findServerScrollContainer() || this.findCloudScrollContainer();
  },

  /**
   * Find scroll container for Jira Server/Data Center
   * The .issue-view element has inline height and overflow:auto
   */
  findServerScrollContainer() {
    const issueView = document.querySelector('.issue-view');

    if (!issueView) {
      return null;
    }

    const style = getComputedStyle(issueView);
    const hasOverflow = style.overflowY === 'auto' || style.overflowY === 'scroll';
    const canScroll = issueView.scrollHeight > issueView.clientHeight + 10;

    if (hasOverflow && canScroll) {
      log('Found Jira Server scroll container: .issue-view', {
        scrollHeight: issueView.scrollHeight,
        clientHeight: issueView.clientHeight
      });
      return issueView;
    }

    return null;
  },

  /**
   * Find scroll container for Jira Cloud
   * Cloud uses React and has different scroll structure
   */
  findCloudScrollContainer() {
    // Jira Cloud potential scroll containers
    const selectors = [
      '[data-testid="issue.views.issue-base.foundation.issue-panel"]',
      '[data-testid="issue-view-scrollable-container"]',
      '[data-testid="issue.views.issue-base.foundation.content"]',
      '[role="main"]'
    ];

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);

      for (const el of elements) {
        const style = getComputedStyle(el);
        const hasOverflow = style.overflowY === 'auto' || style.overflowY === 'scroll';
        const canScroll = el.scrollHeight > el.clientHeight + 10;

        if (hasOverflow && canScroll) {
          log(`Found Jira Cloud scroll container: ${selector}`, {
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight
          });
          return el;
        }
      }
    }

    // Fallback: find largest scrollable element on the page
    return this.findLargestScrollable();
  },

  /**
   * Fallback: find the largest scrollable element
   */
  findLargestScrollable() {
    let bestMatch = null;
    let bestScrollHeight = 0;

    const allElements = document.querySelectorAll('*');

    for (const el of allElements) {
      if (el.offsetWidth < 200 || el.offsetHeight < 200) continue;

      const style = getComputedStyle(el);
      const hasOverflow = style.overflowY === 'auto' || style.overflowY === 'scroll';
      const canScroll = el.scrollHeight > el.clientHeight + 50;

      if (hasOverflow && canScroll && el.scrollHeight > bestScrollHeight) {
        bestScrollHeight = el.scrollHeight;
        bestMatch = el;
      }
    }

    if (bestMatch) {
      log('Found Jira fallback scroll container', {
        tag: bestMatch.tagName,
        id: bestMatch.id,
        scrollHeight: bestMatch.scrollHeight
      });
    }

    return bestMatch;
  },

  /**
   * Get the center content bounds for Jira pages (for center-only capture)
   */
  getCenterBounds() {
    const detection = this.detect();

    if (detection.type === 'jira-server') {
      return this.getServerCenterBounds();
    }

    if (detection.type === 'jira-cloud') {
      return this.getCloudCenterBounds();
    }

    return null;
  },

  /**
   * Get center bounds for Jira Server/Data Center
   */
  getServerCenterBounds() {
    // Try multiple selectors for the left sidebar
    // .aui-sidebar-wrapper is the full navigation panel
    // .aui-sidebar is just an inner element that may have 0 height
    const sidebarWrapper = document.querySelector('.aui-sidebar-wrapper');
    const leftSidebar = document.querySelector('.aui-sidebar');
    const rightSidebar = document.getElementById('viewissuesidebar');
    const issueView = document.querySelector('.issue-view');

    if (!issueView) return null;

    const viewRect = issueView.getBoundingClientRect();

    // Use the sidebar wrapper if available (more reliable), otherwise fall back to .aui-sidebar
    // If neither, use the issueView's left edge
    let leftBound = viewRect.left; // Default to issueView left
    if (sidebarWrapper) {
      const wrapperRect = sidebarWrapper.getBoundingClientRect();
      if (wrapperRect.width > 0) {
        leftBound = wrapperRect.right;
      }
    } else if (leftSidebar) {
      const sidebarRect = leftSidebar.getBoundingClientRect();
      if (sidebarRect.width > 0 && sidebarRect.height > 0) {
        leftBound = sidebarRect.right;
      }
    }

    const rightBound = rightSidebar ? rightSidebar.getBoundingClientRect().left : viewRect.right;

    log('Jira center bounds calculation:', {
      leftBound,
      rightBound,
      issueViewLeft: viewRect.left,
      width: rightBound - leftBound
    });

    return {
      left: Math.round(leftBound),
      right: Math.round(rightBound),
      top: Math.round(viewRect.top),
      width: Math.round(rightBound - leftBound),
      scrollHeight: issueView.scrollHeight,
      clientHeight: issueView.clientHeight
    };
  },

  /**
   * Get center bounds for Jira Cloud
   */
  getCloudCenterBounds() {
    const mainContent = document.querySelector('[data-testid="issue.views.issue-base.foundation.content"]') ||
                        document.querySelector('[role="main"]');

    if (!mainContent) return null;

    const rect = mainContent.getBoundingClientRect();

    return {
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      scrollHeight: mainContent.scrollHeight,
      clientHeight: mainContent.clientHeight
    };
  }
};

/**
 * Site Handler Registry
 * Add new site handlers here to support more websites
 */
const SiteHandlers = [
  JiraHandler
  // Add more handlers here: ConfluenceHandler, ServiceNowHandler, etc.
];

/**
 * Try to find a scroll container using site-specific handlers
 * Returns the scroll container element or null if no handler matches
 */
function findSiteSpecificScrollContainer() {
  for (const handler of SiteHandlers) {
    const detection = handler.detect();
    if (detection.detected) {
      log(`Site handler matched: ${handler.name} (${detection.type})`);
      const container = handler.findScrollContainer();
      if (container) {
        return container;
      }
    }
  }
  return null;
}

// ============================================================================
// CORE SCROLL DETECTION
// ============================================================================

/**
 * Find the main scrollable element on the page
 * Returns window if the document itself is scrollable, otherwise finds the scrollable container
 */
function findScrollableElement() {
  // Check if we already found it
  if (cachedScrollableElement) {
    return cachedScrollableElement;
  }

  // NEW: Check site-specific handlers first (Jira, etc.)
  const siteSpecificContainer = findSiteSpecificScrollContainer();
  if (siteSpecificContainer) {
    cachedScrollableElement = siteSpecificContainer;
    return siteSpecificContainer;
  }

  // Check if the main document is scrollable
  const docScrollable = document.documentElement.scrollHeight > document.documentElement.clientHeight + 10;

  if (docScrollable) {
    log('Main document is scrollable');
    cachedScrollableElement = null; // null means use window
    return null;
  }

  // Document isn't scrollable - find the scrollable container
  log('Main document not scrollable, searching for scrollable container...');

  // Find all elements with overflow scroll/auto that have scrollable content
  const allElements = document.querySelectorAll('*');
  let bestMatch = null;
  let bestScrollHeight = 0;

  for (const el of allElements) {
    const style = getComputedStyle(el);
    const overflowY = style.overflowY;
    const overflow = style.overflow;

    const hasScrollOverflow = overflowY === 'auto' || overflowY === 'scroll' ||
                               overflow === 'auto' || overflow === 'scroll';

    if (hasScrollOverflow && el.scrollHeight > el.clientHeight + 10) {
      // Prefer larger scrollable areas (more content)
      if (el.scrollHeight > bestScrollHeight) {
        bestScrollHeight = el.scrollHeight;
        bestMatch = el;
      }
    }
  }

  if (bestMatch) {
    log('Found scrollable container:', {
      tag: bestMatch.tagName,
      class: bestMatch.className,
      id: bestMatch.id,
      scrollHeight: bestMatch.scrollHeight,
      clientHeight: bestMatch.clientHeight
    });
    cachedScrollableElement = bestMatch;
    return bestMatch;
  }

  log('No scrollable container found, falling back to window');
  return null;
}

/**
 * Get scroll dimensions from the appropriate element
 */
function getScrollDimensions(element) {
  if (element === null) {
    // Use window/document
    return {
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientHeight: window.innerHeight,
      clientWidth: window.innerWidth,
      scrollTop: window.scrollY,
      scrollLeft: window.scrollX
    };
  } else {
    // Use the element
    return {
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft
    };
  }
}

/**
 * Scroll the appropriate element to a position
 */
function scrollElement(element, x, y) {
  if (element === null) {
    window.scrollTo(x, y);
    return {
      scrolledToX: window.scrollX,
      scrolledToY: window.scrollY
    };
  } else {
    element.scrollTo(x, y);
    return {
      scrolledToX: element.scrollLeft,
      scrolledToY: element.scrollTop
    };
  }
}

/**
 * Find and click "expand" or "show more" buttons
 */
async function expandElements() {
  const patterns = [
    'show more',
    'expand',
    'view more',
    'load more',
    'see more',
    'reveal',
    'unfold'
  ];

  const expandButtonRegex = new RegExp(patterns.join('|'), 'i');

  let clickedCount = 0;
  const maxClicks = 50; // Safety limit

  // Find all buttons and links that might expand content
  const elements = document.querySelectorAll('button, a, div[role="button"]');

  for (const element of elements) {
    if (clickedCount >= maxClicks) break;

    const text = element.textContent.toLowerCase().trim();

    // Check if element matches expand pattern
    if (expandButtonRegex.test(text)) {
      // Avoid dangerous actions
      if (/save|submit|delete|remove|cancel|close|exit/i.test(text)) {
        log('Skipping dangerous button:', text);
        continue;
      }

      try {
        log('Clicking expand button:', text);
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(r => setTimeout(r, 100)); // Wait for scroll
        element.click();
        clickedCount++;
        await new Promise(r => setTimeout(r, 500)); // Wait for content to load
      } catch (e) {
        log('Failed to click element:', e);
      }
    }
  }

  log(`Clicked ${clickedCount} expand buttons`);
  return clickedCount;
}

/**
 * Scroll page to load lazy content
 */
async function scrollToBottom(maxDuration = 10000) {
  log('Starting scroll to bottom');
  const scrollable = findScrollableElement();
  const startTime = Date.now();
  let lastHeight = getScrollDimensions(scrollable).scrollHeight;
  let stableCount = 0;
  const stabilityThreshold = 3;

  while (Date.now() - startTime < maxDuration && stableCount < stabilityThreshold) {
    const dims = getScrollDimensions(scrollable);
    scrollElement(scrollable, 0, dims.scrollHeight);
    await new Promise(r => setTimeout(r, 300));

    const newHeight = getScrollDimensions(scrollable).scrollHeight;
    if (newHeight === lastHeight) {
      stableCount++;
      log('Page height stable:', stableCount);
    } else {
      stableCount = 0;
      log('Page height changed:', lastHeight, '→', newHeight);
      lastHeight = newHeight;
    }

    await new Promise(r => setTimeout(r, 100));
  }

  // Scroll back to top
  scrollElement(scrollable, 0, 0);
  log('Scroll complete, final height:', lastHeight);
}

/**
 * Check DOM stability
 */
async function checkDomStability(duration = 2000) {
  log('Checking DOM stability');
  const scrollable = findScrollableElement();
  const startTime = Date.now();
  const measurements = [];

  while (Date.now() - startTime < duration) {
    measurements.push(getScrollDimensions(scrollable).scrollHeight);
    await new Promise(r => setTimeout(r, 100));
  }

  const firstMeasurement = measurements[0];
  const isStable = measurements.every(m => Math.abs(m - firstMeasurement) < 10);

  log('DOM stability check:', isStable, 'Height:', firstMeasurement);
  return isStable;
}

/**
 * Perform pre-capture DOM stabilization
 */
async function performDomStabilization(maxDuration) {
  try {
    log('Starting DOM stabilization with max duration:', maxDuration);
    const startTime = Date.now();

    await expandElements();

    const remainingTime = maxDuration - (Date.now() - startTime);
    if (remainingTime > 1000) {
      await scrollToBottom(Math.min(remainingTime, 5000));
    }

    await checkDomStability(1000);

    const elapsed = Date.now() - startTime;
    log(`DOM stabilization completed in ${elapsed}ms`);

  } catch (e) {
    error('DOM stabilization failed:', e);
  }
}

/**
 * Get page dimensions for scroll capture
 */
function getPageDimensions() {
  // Reset cache to re-detect scrollable element
  cachedScrollableElement = null;

  const scrollable = findScrollableElement();
  const dims = getScrollDimensions(scrollable);

  // Determine if we're using a custom container
  const useCustomContainer = scrollable !== null;

  // Get container bounds if using custom container
  let containerBounds = null;
  if (useCustomContainer && scrollable) {
    const rect = scrollable.getBoundingClientRect();
    containerBounds = {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
  }

  return {
    scrollHeight: dims.scrollHeight,
    scrollWidth: dims.scrollWidth,
    viewportHeight: dims.clientHeight,
    viewportWidth: dims.clientWidth,
    currentScrollY: dims.scrollTop,
    currentScrollX: dims.scrollLeft,
    devicePixelRatio: window.devicePixelRatio || 1,
    useCustomContainer: useCustomContainer,
    containerSelector: useCustomContainer ? describeElement(scrollable) : null,
    containerBounds: containerBounds,
    windowHeight: window.innerHeight,
    windowWidth: window.innerWidth
  };
}

/**
 * Create a selector description for an element (for debugging)
 */
function describeElement(el) {
  if (!el) return null;
  let desc = el.tagName.toLowerCase();
  if (el.id) desc += '#' + el.id;
  if (el.className) desc += '.' + el.className.split(' ')[0];
  return desc;
}

/**
 * Scroll to a specific position
 */
function scrollToPosition(x, y) {
  return new Promise((resolve) => {
    const scrollable = findScrollableElement();
    const result = scrollElement(scrollable, x, y);

    // Wait for scroll to settle
    setTimeout(() => {
      // Re-read actual position after settling
      const dims = getScrollDimensions(scrollable);
      resolve({
        scrolledToX: dims.scrollLeft,
        scrolledToY: dims.scrollTop
      });
    }, 150);
  });
}

/**
 * Message listener
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Simple ping to check if content script is loaded
  if (message.type === 'PING') {
    sendResponse({ success: true, loaded: true });
    return true;
  }

  if (message.type === 'DOM_STABILIZE') {
    log('Received DOM_STABILIZE request');

    performDomStabilization(message.maxDuration || 10000)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((e) => {
        error('Stabilization error:', e);
        sendResponse({ success: false, error: e.message });
      });

    return true;
  }

  if (message.type === 'SCROLL_CAPTURE_INIT') {
    log('Received SCROLL_CAPTURE_INIT request');
    try {
      const dims = getPageDimensions();
      log('Page dimensions:', dims);
      sendResponse({ success: true, ...dims });
    } catch (e) {
      error('Failed to get page dimensions:', e);
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  if (message.type === 'SCROLL_TO') {
    log(`Received SCROLL_TO request: x=${message.x}, y=${message.y}`);
    scrollToPosition(message.x || 0, message.y || 0)
      .then((result) => {
        log('Scroll completed:', result);
        sendResponse({ success: true, ...result });
      })
      .catch((e) => {
        error('Failed to scroll:', e);
        sendResponse({ success: false, error: e.message });
      });
    return true;
  }
});

/**
 * Element Selector UI - State variables
 */
let elementSelectorActive = false;
let selectorOverlay = null;
let highlightBox = null;
let selectedElement = null;

/**
 * Sticky/Fixed element handling for clean captures
 */
let hiddenFixedElements = [];

/**
 * Find all fixed/sticky positioned elements on the page
 * Only targets elements that directly have position:fixed or position:sticky
 */
function findFixedElements() {
  const fixed = [];
  const seen = new Set();
  const all = document.querySelectorAll('*');

  for (const el of all) {
    // Skip our own overlay elements
    // Note: el.id can be an SVGAnimatedString for SVG elements, so convert to string first
    const elId = typeof el.id === 'string' ? el.id : (el.id?.baseVal || '');
    if (elId && elId.startsWith('longshot-')) continue;
    if (seen.has(el)) continue;

    const style = getComputedStyle(el);

    // Skip invisible elements
    if (style.display === 'none' || style.visibility === 'hidden' ||
        el.offsetWidth === 0 || el.offsetHeight === 0) {
      continue;
    }

    // Only target elements that directly have position:fixed or position:sticky
    if (style.position === 'fixed' || style.position === 'sticky') {
      // Skip if an ancestor is already in our list (avoid hiding nested elements separately)
      let ancestorAlreadyHidden = false;
      let parent = el.parentElement;
      while (parent) {
        if (seen.has(parent)) {
          ancestorAlreadyHidden = true;
          break;
        }
        parent = parent.parentElement;
      }

      if (!ancestorAlreadyHidden) {
        fixed.push({
          element: el,
          originalDisplay: el.style.display
        });
        seen.add(el);
        log(`Found fixed/sticky element: ${el.tagName}.${el.className}, position: ${style.position}`);
      }
    }
  }

  log(`Found ${fixed.length} fixed/sticky elements to hide`);
  return fixed;
}

/**
 * Hide all fixed/sticky elements (for captures after the first)
 */
function hideFixedElements() {
  if (hiddenFixedElements.length === 0) {
    hiddenFixedElements = findFixedElements();
  }

  for (const item of hiddenFixedElements) {
    item.element.style.display = 'none';
  }

  log(`Hidden ${hiddenFixedElements.length} fixed elements with display:none`);
}

/**
 * Restore all fixed/sticky elements
 */
function restoreFixedElements() {
  for (const item of hiddenFixedElements) {
    item.element.style.display = item.originalDisplay || '';
  }

  log(`Restored ${hiddenFixedElements.length} fixed elements from display:none`);
  hiddenFixedElements = [];
}

/**
 * Show element selector UI
 * Creates overlay and highlight box for element selection
 */
function showElementSelector() {
  if (elementSelectorActive) {
    log('Element selector already active');
    return;
  }

  elementSelectorActive = true;
  log('Showing element selector');

  // Create dimming overlay
  selectorOverlay = document.createElement('div');
  selectorOverlay.id = 'longshot-selector-overlay';
  selectorOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(0, 0, 0, 0.3);
    z-index: 2147483647;
    cursor: crosshair;
  `;

  // Create highlight box
  highlightBox = document.createElement('div');
  highlightBox.id = 'longshot-highlight-box';
  highlightBox.style.cssText = `
    position: fixed;
    display: none;
    background-color: rgba(102, 126, 234, 0.3);
    border: 2px solid #667eea;
    z-index: 2147483648;
    pointer-events: none;
    box-sizing: border-box;
  `;

  // Create instruction banner
  const banner = document.createElement('div');
  banner.id = 'longshot-selector-banner';
  banner.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 12px 20px;
    border-radius: 4px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    z-index: 2147483649;
    pointer-events: none;
    white-space: nowrap;
  `;
  banner.textContent = 'Click an element to capture. Press Escape to cancel.';

  // Add event listeners
  selectorOverlay.addEventListener('mousemove', handleElementHover);
  selectorOverlay.addEventListener('click', handleElementClick);
  document.addEventListener('keydown', handleSelectorKeydown);

  // Add elements to DOM
  document.body.appendChild(selectorOverlay);
  document.body.appendChild(highlightBox);
  document.body.appendChild(banner);

  log('Element selector UI created');
}

/**
 * Handle element hover - update highlight box position
 */
function handleElementHover(e) {
  if (!elementSelectorActive) return;

  // Temporarily hide overlay to get the real element underneath
  const overlay = document.getElementById('longshot-selector-overlay');
  overlay.style.pointerEvents = 'none';
  const element = document.elementFromPoint(e.clientX, e.clientY);
  overlay.style.pointerEvents = 'auto';

  // Skip if element is part of our UI
  if (!element || element.id === 'longshot-selector-overlay' ||
      element.id === 'longshot-highlight-box' ||
      element.id === 'longshot-selector-banner' ||
      element.closest('#longshot-selector-banner')) {
    highlightBox.style.display = 'none';
    return;
  }

  // Get bounding rect of element
  const rect = element.getBoundingClientRect();

  // Position highlight box
  highlightBox.style.left = rect.left + 'px';
  highlightBox.style.top = rect.top + 'px';
  highlightBox.style.width = rect.width + 'px';
  highlightBox.style.height = rect.height + 'px';
  highlightBox.style.display = 'block';
}

/**
 * Handle element click - select element for capture
 */
function handleElementClick(e) {
  if (!elementSelectorActive) return;

  e.preventDefault();
  e.stopPropagation();

  // Temporarily hide overlay to get the real element
  const overlay = document.getElementById('longshot-selector-overlay');
  overlay.style.pointerEvents = 'none';
  const element = document.elementFromPoint(e.clientX, e.clientY);
  overlay.style.pointerEvents = 'auto';

  if (!element || element.id === 'longshot-selector-overlay' ||
      element.id === 'longshot-highlight-box' ||
      element.id === 'longshot-selector-banner') {
    return;
  }

  selectedElement = element;
  log('Element selected:', describeElement(selectedElement));

  // Get element's bounding rect and scroll dimensions
  const rect = selectedElement.getBoundingClientRect();
  const scrollHeight = selectedElement.scrollHeight;
  const scrollWidth = selectedElement.scrollWidth;
  const clientHeight = selectedElement.clientHeight;
  const clientWidth = selectedElement.clientWidth;
  const isScrollable = scrollHeight > clientHeight || scrollWidth > clientWidth;

  const elementInfo = {
    boundingRect: {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    },
    scrollWidth: scrollWidth,
    scrollHeight: scrollHeight,
    clientWidth: clientWidth,
    clientHeight: clientHeight,
    isScrollable: isScrollable,
    tagName: selectedElement.tagName,
    className: selectedElement.className,
    id: selectedElement.id
  };

  log('Element info:', elementInfo);

  // Clean up selector UI
  cleanupElementSelector();

  // Send message to background
  chrome.runtime.sendMessage({
    type: 'ELEMENT_SELECTED',
    elementInfo: elementInfo
  }, (response) => {
    if (chrome.runtime.lastError) {
      error('Failed to send ELEMENT_SELECTED message:', chrome.runtime.lastError);
    } else {
      log('ELEMENT_SELECTED message sent, response:', response);
    }
  });
}

/**
 * Handle keydown events in selector mode
 */
function handleSelectorKeydown(e) {
  if (!elementSelectorActive) return;

  if (e.key === 'Escape') {
    log('Element selector cancelled');
    cleanupElementSelector();
  }
}

/**
 * Clean up element selector UI
 */
function cleanupElementSelector() {
  if (!elementSelectorActive) return;

  log('Cleaning up element selector');

  // Remove event listeners
  if (selectorOverlay) {
    selectorOverlay.removeEventListener('mousemove', handleElementHover);
    selectorOverlay.removeEventListener('click', handleElementClick);
  }
  document.removeEventListener('keydown', handleSelectorKeydown);

  // Remove overlay banner
  const banner = document.getElementById('longshot-selector-banner');
  if (banner) banner.remove();

  // Remove overlay
  if (selectorOverlay) selectorOverlay.remove();

  // Remove highlight box
  if (highlightBox) highlightBox.remove();

  // Reset state
  selectorOverlay = null;
  highlightBox = null;
  elementSelectorActive = false;

  log('Element selector cleaned up');
}

/**
 * Extend message listener for element selector
 */
const originalListener = chrome.runtime.onMessage.addListener;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // START_ELEMENT_SELECT: Initiate element selection
  if (message.type === 'START_ELEMENT_SELECT') {
    log('Received START_ELEMENT_SELECT request');
    try {
      showElementSelector();
      sendResponse({ success: true });
    } catch (e) {
      error('Failed to start element selector:', e);
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // ELEMENT_CAPTURE_INIT: Get current element's scroll dimensions
  if (message.type === 'ELEMENT_CAPTURE_INIT') {
    log('Received ELEMENT_CAPTURE_INIT request');
    try {
      if (!selectedElement) {
        sendResponse({ success: false, error: 'No element selected' });
        return true;
      }

      const rect = selectedElement.getBoundingClientRect();
      // Calculate element's position relative to the scroll container
      // Use the same scroll container that scrollToPosition uses
      const scrollable = findScrollableElement();
      const scrollTop = scrollable ? scrollable.scrollTop : window.scrollY;
      const scrollLeft = scrollable ? scrollable.scrollLeft : window.scrollX;
      const elementPageTop = rect.top + scrollTop;
      const elementPageLeft = rect.left + scrollLeft;

      const dims = {
        scrollHeight: selectedElement.scrollHeight,
        scrollWidth: selectedElement.scrollWidth,
        clientHeight: selectedElement.clientHeight,
        clientWidth: selectedElement.clientWidth,
        currentScrollY: selectedElement.scrollTop,
        currentScrollX: selectedElement.scrollLeft,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        devicePixelRatio: window.devicePixelRatio || 1,
        elementPageTop: elementPageTop,
        elementPageLeft: elementPageLeft,
        boundingRect: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height
        }
      };

      log('Element capture init:', dims);
      sendResponse({ success: true, ...dims });
    } catch (e) {
      error('Failed to get element capture init:', e);
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // ELEMENT_SCROLL_TO: Scroll element to position
  if (message.type === 'ELEMENT_SCROLL_TO') {
    const scrollX = message.scrollX || message.x || 0;
    const scrollY = message.scrollY || message.y || 0;
    log(`Received ELEMENT_SCROLL_TO request: x=${scrollX}, y=${scrollY}`);
    try {
      if (!selectedElement) {
        sendResponse({ success: false, error: 'No element selected' });
        return true;
      }

      selectedElement.scrollTo(scrollX, scrollY);

      // Wait for scroll to settle
      setTimeout(() => {
        const result = {
          scrolledToX: selectedElement.scrollLeft,
          scrolledToY: selectedElement.scrollTop
        };
        log('Element scroll completed:', result);
        sendResponse({ success: true, ...result });
      }, 150);
    } catch (e) {
      error('Failed to scroll element:', e);
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // CLEANUP_ELEMENT_SELECT: Clean up selector
  if (message.type === 'CLEANUP_ELEMENT_SELECT') {
    log('Received CLEANUP_ELEMENT_SELECT request');
    try {
      cleanupElementSelector();
      selectedElement = null;
      sendResponse({ success: true });
    } catch (e) {
      error('Failed to cleanup element selector:', e);
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // HIDE_FIXED_ELEMENTS: Hide sticky/fixed headers for clean captures
  if (message.type === 'HIDE_FIXED_ELEMENTS') {
    log('Received HIDE_FIXED_ELEMENTS request');
    try {
      hideFixedElements();
      sendResponse({ success: true });
    } catch (e) {
      error('Failed to hide fixed elements:', e);
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // RESTORE_FIXED_ELEMENTS: Restore sticky/fixed elements after capture
  if (message.type === 'RESTORE_FIXED_ELEMENTS') {
    log('Received RESTORE_FIXED_ELEMENTS request');
    try {
      restoreFixedElements();
      sendResponse({ success: true });
    } catch (e) {
      error('Failed to restore fixed elements:', e);
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // JIRA_CENTER_CAPTURE_INIT: Initialize center-section capture for Jira pages
  if (message.type === 'JIRA_CENTER_CAPTURE_INIT') {
    log('Received JIRA_CENTER_CAPTURE_INIT request');
    try {
      const detection = JiraHandler.detect();
      if (!detection.detected) {
        sendResponse({ success: false, error: 'Not a Jira page' });
        return true;
      }

      const centerBounds = JiraHandler.getCenterBounds();
      if (!centerBounds) {
        sendResponse({ success: false, error: 'Could not determine Jira center bounds' });
        return true;
      }

      const scrollContainer = JiraHandler.findScrollContainer();
      const scrollInfo = scrollContainer ? {
        scrollHeight: scrollContainer.scrollHeight,
        clientHeight: scrollContainer.clientHeight,
        scrollTop: scrollContainer.scrollTop
      } : {
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: window.innerHeight,
        scrollTop: window.scrollY
      };

      const result = {
        jiraType: detection.type,
        centerBounds: centerBounds,
        scrollInfo: scrollInfo,
        devicePixelRatio: window.devicePixelRatio || 1,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        hasScrollContainer: !!scrollContainer
      };

      log('Jira center capture init:', result);
      sendResponse({ success: true, ...result });
    } catch (e) {
      error('Failed to initialize Jira center capture:', e);
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // JIRA_CENTER_SCROLL_TO: Scroll Jira's scroll container for center capture
  if (message.type === 'JIRA_CENTER_SCROLL_TO') {
    const scrollY = message.y || 0;
    log(`Received JIRA_CENTER_SCROLL_TO request: y=${scrollY}`);
    try {
      const scrollContainer = JiraHandler.findScrollContainer();

      if (scrollContainer) {
        scrollContainer.scrollTo(0, scrollY);
      } else {
        window.scrollTo(0, scrollY);
      }

      // Wait for scroll to settle
      setTimeout(() => {
        const actualScrollY = scrollContainer ? scrollContainer.scrollTop : window.scrollY;
        log('Jira center scroll completed:', { scrolledToY: actualScrollY });
        sendResponse({ success: true, scrolledToY: actualScrollY });
      }, 150);
    } catch (e) {
      error('Failed to scroll Jira center:', e);
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // DETECT_SITE_TYPE: Check if current page has a site-specific handler
  if (message.type === 'DETECT_SITE_TYPE') {
    log('Received DETECT_SITE_TYPE request');
    try {
      for (const handler of SiteHandlers) {
        const detection = handler.detect();
        if (detection.detected) {
          sendResponse({
            success: true,
            detected: true,
            siteType: handler.name,
            detectionType: detection.type
          });
          return true;
        }
      }
      sendResponse({ success: true, detected: false });
    } catch (e) {
      error('Failed to detect site type:', e);
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }
});

log('Content script loaded');
