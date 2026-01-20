/**
 * Background Service Worker
 * Orchestrates page capture using scroll-and-stitch method
 */

const DEBUG = true;

function log(...args) {
  if (DEBUG) console.log('[Background]', ...args);
}

function error(...args) {
  console.error('[Background]', ...args);
}

// Default configuration
const DEFAULT_CONFIG = {
  preCapture: false,
  preCaptureMaxDuration: 10000
};

// Store active capture sessions with detailed progress
const activeSessions = new Map();

// Current capture state (for popup to query)
let currentCaptureState = null;

/**
 * Update capture state (for popup to query when reopened)
 */
function updateCaptureState(sessionId, status, message, progress = null) {
  currentCaptureState = {
    sessionId,
    status,
    message,
    progress,
    timestamp: Date.now()
  };
  // Also notify popup (if open)
  notifyPopup(sessionId, status, message, progress);
}

/**
 * Sanitize string for use in filename
 */
function sanitizeForFilename(str, maxLength = 50) {
  if (!str) return '';
  return str
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '') // Remove invalid filename chars
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, '') // Remove leading/trailing underscores
    .substring(0, maxLength);
}

/**
 * Ensure content script is injected into the tab
 * This is needed for pages that were open before extension reload
 */
async function ensureContentScript(tabId) {
  try {
    // Try to ping the content script first
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    log('Content script already present');
    return true;
  } catch (e) {
    // Content script not present, inject it
    log('Content script not present, injecting...');
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['contentScript.js']
      });
      log('Content script injected successfully');
      // Give it a moment to initialize
      await new Promise(r => setTimeout(r, 100));
      return true;
    } catch (injectError) {
      error('Failed to inject content script:', injectError);
      throw new Error(`Cannot inject content script: ${injectError.message}`);
    }
  }
}

/**
 * Get current tab
 */
async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error('No active tab found');
  return tabs[0];
}

/**
 * Capture visible tab as PNG
 */
async function captureVisibleTab(tabId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(
      { format: 'png', quality: 100 }
    );

    // Convert data URL to blob
    const response = await fetch(dataUrl);
    return await response.blob();
  } catch (e) {
    throw new Error(`Failed to capture visible tab: ${e.message}`);
  }
}

/**
 * Scroll and stitch capture - full page capture by scrolling and combining viewports
 */
async function scrollAndStitchCapture(tabId, sessionId) {
  log('Starting scroll-and-stitch capture');

  try {
    // Step 0: Ensure content script is injected
    updateCaptureState(sessionId, 'preparing', 'Preparing page...');
    await ensureContentScript(tabId);

    // Step 1: Get page dimensions
    updateCaptureState(sessionId, 'capturing', 'Getting page dimensions...');
    const dims = await chrome.tabs.sendMessage(tabId, {
      type: 'SCROLL_CAPTURE_INIT'
    });

    if (!dims.success) {
      throw new Error('Failed to get page dimensions');
    }

    log('Page dimensions:', dims);

    const scrollHeight = dims.scrollHeight;
    const viewportHeight = dims.viewportHeight;
    const viewportWidth = dims.viewportWidth;
    const originalScrollY = dims.currentScrollY;
    const devicePixelRatio = dims.devicePixelRatio;

    // Configuration
    const OVERLAP_HEIGHT = 75; // 75px overlap between captures to avoid seams
    const MAX_CAPTURES = 100; // Safety limit to prevent infinite loops
    const MAX_TOTAL_HEIGHT = 32000; // Prevent excessive memory usage

    // Calculate number of captures needed
    let numCaptures = 1;
    if (scrollHeight > viewportHeight) {
      const scrollableHeight = scrollHeight - viewportHeight;
      numCaptures = Math.ceil(scrollableHeight / (viewportHeight - OVERLAP_HEIGHT)) + 1;
    }

    // Enforce limits
    numCaptures = Math.min(numCaptures, MAX_CAPTURES);
    log(`Will capture ${numCaptures} viewports (page height: ${scrollHeight}, viewport: ${viewportHeight})`);

    if (scrollHeight > MAX_TOTAL_HEIGHT) {
      log(`WARNING: Page height ${scrollHeight}px exceeds limit ${MAX_TOTAL_HEIGHT}px, may produce large file`);
    }

    // Step 2: Capture each viewport
    const captures = [];

    for (let i = 0; i < numCaptures; i++) {
      const scrollY = i * (viewportHeight - OVERLAP_HEIGHT);

      // Don't scroll past the bottom
      if (scrollY > scrollHeight - viewportHeight) {
        log(`Capture ${i + 1}: Would exceed page height, stopping`);
        break;
      }

      log(`Capture ${i + 1}/${numCaptures}: Scrolling to Y=${scrollY}`);
      const progress = Math.round((i / numCaptures) * 100);
      updateCaptureState(sessionId, 'capturing', `Capturing viewport ${i + 1}/${numCaptures}...`, progress);

      // Scroll to position
      const scrollResult = await chrome.tabs.sendMessage(tabId, {
        type: 'SCROLL_TO',
        x: 0,
        y: scrollY
      });

      if (!scrollResult.success) {
        throw new Error(`Failed to scroll to Y=${scrollY}`);
      }

      log(`Capture ${i + 1}: Scroll confirmed at Y=${scrollResult.scrolledToY}`);

      // Wait for content to render and to avoid rate limiting
      // Chrome limits captureVisibleTab to ~2 calls per second
      await new Promise(r => setTimeout(r, 600));

      // Capture visible tab with retry logic for rate limiting
      log(`Capture ${i + 1}: Taking screenshot...`);
      let dataUrl;
      let retries = 3;
      while (retries > 0) {
        try {
          dataUrl = await chrome.tabs.captureVisibleTab(
            { format: 'png', quality: 100 }
          );
          break; // Success, exit retry loop
        } catch (captureError) {
          retries--;
          if (captureError.message.includes('quota') && retries > 0) {
            log(`Rate limited, waiting and retrying... (${retries} retries left)`);
            await new Promise(r => setTimeout(r, 1000)); // Wait 1 second before retry
          } else {
            throw captureError;
          }
        }
      }

      // Convert to blob and store metadata
      const response = await fetch(dataUrl);
      const blob = await response.blob();

      captures.push({
        blob,
        scrollY,
        viewportHeight,
        viewportWidth,
        isLastCapture: scrollY + viewportHeight >= scrollHeight
      });

      log(`Capture ${i + 1}: Stored (size: ${blob.size} bytes)`);
    }

    if (captures.length === 0) {
      throw new Error('No captures were collected');
    }

    log(`Collected ${captures.length} captures, sending to offscreen for stitching`);

    // Step 3: Convert blobs to data URLs for transmission
    updateCaptureState(sessionId, 'stitching', 'Stitching captures together...', 95);

    const captureDataUrls = [];
    for (let i = 0; i < captures.length; i++) {
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(captures[i].blob);
      });
      captureDataUrls.push({
        dataUrl,
        scrollY: captures[i].scrollY,
        viewportHeight: captures[i].viewportHeight,
        viewportWidth: captures[i].viewportWidth,
        isLastCapture: captures[i].isLastCapture
      });
    }

    // Step 4: Create offscreen document and send for stitching
    await createOffscreenDocument();

    const stitchResult = await sendToOffscreen({
      type: 'STITCH_CAPTURES',
      captures: captureDataUrls,
      overlapHeight: OVERLAP_HEIGHT,
      tabUrl: 'page'
    });

    if (!stitchResult || stitchResult.error) {
      throw new Error(stitchResult?.error || 'Offscreen stitching failed');
    }

    log('Stitching complete, received:', stitchResult.pngBlobUrl);

    // Step 5: Restore original scroll position
    log('Restoring original scroll position...');
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SCROLL_TO',
        x: 0,
        y: originalScrollY
      });
    } catch (e) {
      log('Warning: Could not restore scroll position:', e);
    }

    return stitchResult;

  } catch (e) {
    error('Scroll-and-stitch capture failed:', e);
    throw e;
  }
}

/**
 * Start element selection mode
 * Instructs content script to enter element select mode
 */
async function startElementSelect() {
  log('Starting element select mode');

  try {
    // Get current tab
    const tab = await getCurrentTab();
    if (!tab.id) throw new Error('Tab ID not available');

    // Validate URL is capturable
    if (!isCapturableUrl(tab.url)) {
      throw new Error('Cannot capture this page. Please navigate to a regular website.');
    }

    // Ensure content script is loaded
    await ensureContentScript(tab.id);

    // Send START_ELEMENT_SELECT message to content script
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'START_ELEMENT_SELECT'
    });

    if (!response.success) {
      throw new Error('Failed to start element selection');
    }

    log('Element select mode activated');

  } catch (e) {
    error('Failed to start element select:', e);
    throw e;
  }
}

/**
 * Capture element by scrolling within element bounds and stitching
 */
async function elementCapture(tabId, elementInfo, sessionId) {
  log('Starting element capture');

  try {
    // Step 1: Get current element dimensions
    updateCaptureState(sessionId, 'capturing', 'Getting element dimensions...');

    const dims = await chrome.tabs.sendMessage(tabId, {
      type: 'ELEMENT_CAPTURE_INIT',
      elementId: elementInfo.elementId
    });

    if (!dims.success) {
      throw new Error('Failed to get element dimensions');
    }

    log('Element dimensions:', dims);

    const elementScrollHeight = dims.scrollHeight;
    const elementClientHeight = dims.clientHeight;
    const viewportHeight = dims.viewportHeight;
    const viewportWidth = dims.viewportWidth;
    const originalElementScrollY = dims.currentScrollY;
    const boundingRect = dims.boundingRect;
    const devicePixelRatio = dims.devicePixelRatio;

    // Configuration
    const OVERLAP_HEIGHT = 75;
    const MAX_CAPTURES = 100;
    const MAX_TOTAL_HEIGHT = 32000;

    // Calculate number of captures needed
    let numCaptures = 1;
    if (elementScrollHeight > elementClientHeight) {
      const scrollableHeight = elementScrollHeight - elementClientHeight;
      numCaptures = Math.ceil(scrollableHeight / (elementClientHeight - OVERLAP_HEIGHT)) + 1;
    }

    numCaptures = Math.min(numCaptures, MAX_CAPTURES);
    log(`Will capture ${numCaptures} viewports (element height: ${elementScrollHeight}, viewport: ${elementClientHeight})`);

    if (elementScrollHeight > MAX_TOTAL_HEIGHT) {
      log(`WARNING: Element height ${elementScrollHeight}px exceeds limit ${MAX_TOTAL_HEIGHT}px, may produce large file`);
    }

    // Step 2: Capture each viewport within element bounds
    const captures = [];

    for (let i = 0; i < numCaptures; i++) {
      const scrollY = i * (elementClientHeight - OVERLAP_HEIGHT);

      // Don't scroll past the element's bottom
      if (scrollY > elementScrollHeight - elementClientHeight) {
        log(`Capture ${i + 1}: Would exceed element height, stopping`);
        break;
      }

      log(`Capture ${i + 1}/${numCaptures}: Scrolling element to Y=${scrollY}`);
      const progress = Math.round((i / numCaptures) * 100);
      updateCaptureState(sessionId, 'capturing', `Capturing element viewport ${i + 1}/${numCaptures}...`, progress);

      // Scroll element to position
      const scrollResult = await chrome.tabs.sendMessage(tabId, {
        type: 'ELEMENT_SCROLL_TO',
        elementId: elementInfo.elementId,
        scrollY
      });

      if (!scrollResult.success) {
        throw new Error(`Failed to scroll element to Y=${scrollY}`);
      }

      log(`Capture ${i + 1}: Element scroll confirmed at Y=${scrollResult.scrolledToY}`);

      // Wait for content to render
      await new Promise(r => setTimeout(r, 600));

      // Capture visible tab with retry logic
      log(`Capture ${i + 1}: Taking screenshot...`);
      let dataUrl;
      let retries = 3;
      while (retries > 0) {
        try {
          dataUrl = await chrome.tabs.captureVisibleTab(
            { format: 'png', quality: 100 }
          );
          break;
        } catch (captureError) {
          retries--;
          if (captureError.message.includes('quota') && retries > 0) {
            log(`Rate limited, waiting and retrying... (${retries} retries left)`);
            await new Promise(r => setTimeout(r, 1000));
          } else {
            throw captureError;
          }
        }
      }

      // Convert to blob and store metadata
      const response = await fetch(dataUrl);
      const blob = await response.blob();

      captures.push({
        blob,
        scrollY,
        viewportHeight: elementClientHeight,
        viewportWidth,
        isLastCapture: scrollY + elementClientHeight >= elementScrollHeight
      });

      log(`Capture ${i + 1}: Stored (size: ${blob.size} bytes)`);
    }

    if (captures.length === 0) {
      throw new Error('No captures were collected');
    }

    log(`Collected ${captures.length} element captures, sending to offscreen for stitching`);

    // Step 3: Convert blobs to data URLs for transmission
    updateCaptureState(sessionId, 'stitching', 'Stitching captures together...', 95);

    const captureDataUrls = [];
    for (let i = 0; i < captures.length; i++) {
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(captures[i].blob);
      });
      captureDataUrls.push({
        dataUrl,
        scrollY: captures[i].scrollY,
        viewportHeight: captures[i].viewportHeight,
        viewportWidth: captures[i].viewportWidth,
        isLastCapture: captures[i].isLastCapture
      });
    }

    // Step 4: Create offscreen document and send for stitching
    await createOffscreenDocument();

    const elementBounds = {
      width: boundingRect.width,
      height: boundingRect.height,
      offsetX: boundingRect.x,
      offsetY: boundingRect.y,
      devicePixelRatio: devicePixelRatio
    };

    log('Sending to offscreen with bounds:', elementBounds);

    const stitchResult = await sendToOffscreen({
      type: 'STITCH_ELEMENT_CAPTURES',
      captures: captureDataUrls,
      overlapHeight: OVERLAP_HEIGHT,
      elementBounds,
      tabUrl: 'element'
    });

    if (!stitchResult || stitchResult.error) {
      throw new Error(stitchResult?.error || 'Offscreen stitching failed');
    }

    log('Element stitching complete, received:', stitchResult.pngBlobUrl);

    // Step 5: Restore original element scroll position
    log('Restoring original element scroll position...');
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'ELEMENT_SCROLL_TO',
        elementId: elementInfo.elementId,
        scrollY: originalElementScrollY
      });
    } catch (e) {
      log('Warning: Could not restore element scroll position:', e);
    }

    return stitchResult;

  } catch (e) {
    error('Element capture failed:', e);
    throw e;
  }
}

/**
 * Pre-capture DOM stabilization
 */
async function stabilizeDOM(tabId, maxDuration) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'DOM_STABILIZE',
      maxDuration
    });
    log('DOM stabilization requested');
  } catch (e) {
    log('DOM stabilization not available or failed:', e.message);
  }
}

/**
 * Check if offscreen document already exists
 */
async function hasOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return contexts.length > 0;
  } catch (e) {
    // Fallback for older Chrome versions
    return false;
  }
}

/**
 * Create offscreen document for stitching
 */
async function createOffscreenDocument() {
  // Check if already exists
  if (await hasOffscreenDocument()) {
    log('Offscreen document already exists');
    return;
  }

  try {
    log('Creating offscreen document...');
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Stitch captured viewport images into full-page PNG'
    });
    log('Offscreen document created successfully');

    // Give it time to initialize
    await new Promise(resolve => setTimeout(resolve, 300));
  } catch (e) {
    // Document might already exist (race condition)
    if (e.message && e.message.includes('already exists')) {
      log('Offscreen document already exists (race condition)');
    } else {
      error('Failed to create offscreen document:', e);
      throw e;
    }
  }
}

/**
 * Send message to offscreen document
 */
function sendToOffscreen(message) {
  log(`Sending to offscreen: ${message.type}`);
  return chrome.runtime.sendMessage(message)
    .then(response => {
      if (response === undefined) {
        throw new Error('No response from offscreen document');
      }
      log('Offscreen response received:', response.success ? 'success' : (response.error || 'unknown'));
      return response;
    })
    .catch(e => {
      error('Failed to send to offscreen:', e);
      throw e;
    });
}

/**
 * Check if a URL is capturable (not a restricted browser URL)
 */
function isCapturableUrl(url) {
  if (!url) return false;

  const restrictedSchemes = [
    'chrome://',
    'chrome-extension://',
    'brave://',
    'edge://',
    'opera://',
    'about:',
    'view-source:',
    'file://'
  ];

  return !restrictedSchemes.some(scheme => url.startsWith(scheme));
}

/**
 * Start page capture using scroll-and-stitch method
 */
async function startCapture(config) {
  const sessionId = Math.random().toString(36).substring(7);
  log(`Starting capture session ${sessionId}`);

  try {
    // Get current tab
    const tab = await getCurrentTab();
    if (!tab.id) throw new Error('Tab ID not available');

    // Validate URL is capturable
    if (!isCapturableUrl(tab.url)) {
      const errorMsg = 'Cannot capture this page. Please navigate to a regular website.\n\n' +
                       'Browser internal pages cannot be captured for security reasons.';
      updateCaptureState(sessionId, 'error', errorMsg);
      throw new Error('URL not capturable');
    }

    // Store session
    activeSessions.set(sessionId, {
      tabId: tab.id,
      startTime: Date.now(),
      status: 'started'
    });

    updateCaptureState(sessionId, 'started', 'Starting capture...');

    // Pre-capture stabilization if enabled
    if (config.preCapture) {
      updateCaptureState(sessionId, 'stabilizing', 'Stabilizing DOM...');
      await stabilizeDOM(tab.id, config.preCaptureMaxDuration);
      await new Promise(r => setTimeout(r, 500));
    }

    // Use scroll-and-stitch capture (PRIMARY METHOD)
    const stitchResult = await scrollAndStitchCapture(tab.id, sessionId);

    // Download the stitched PNG
    const hostname = new URL(tab.url || 'https://page').hostname || 'page';
    const tabTitle = sanitizeForFilename(tab.title || '', 40);
    const timestamp = new Date().toISOString().replace(/[^\d]/g, '').substring(0, 14);
    const filename = tabTitle
      ? `${tabTitle}_${hostname}_${timestamp}.png`
      : `capture_${hostname}_${timestamp}.png`;

    updateCaptureState(sessionId, 'downloading', 'Downloading image...');

    await chrome.downloads.download({
      url: stitchResult.pngBlobUrl,
      filename,
      saveAs: false
    });

    // Clean up blob URL (may not work in service worker context)
    try {
      if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
        URL.revokeObjectURL(stitchResult.pngBlobUrl);
      }
    } catch (e) {
      log('Could not revoke blob URL (expected in service worker):', e.message);
    }
    updateCaptureState(sessionId, 'completed', 'Capture complete!', 100);
    log(`Capture session ${sessionId} completed successfully`);

    // Clear capture state after a short delay (so popup can show completion)
    setTimeout(() => {
      if (currentCaptureState && currentCaptureState.sessionId === sessionId) {
        currentCaptureState = null;
      }
    }, 5000);

  } catch (e) {
    error(`Capture failed: ${e.message}`);
    updateCaptureState(sessionId, 'error', `Capture failed: ${e.message}`);
  } finally {
    activeSessions.delete(sessionId);
  }

  return sessionId;
}

/**
 * Generate filename with hostname and timestamp
 */
function generateFilename(url, ext, suffix = '') {
  const hostname = new URL(url).hostname || 'page';
  const timestamp = new Date().toISOString().replace(/[^\d]/g, '').substring(0, 14);
  const suffixStr = suffix ? `_${suffix}` : '';
  return `capture_${hostname}_${timestamp}${suffixStr}.${ext}`;
}

/**
 * Notify popup of status
 */
function notifyPopup(sessionId, status, message = '', progress = null) {
  try {
    chrome.runtime.sendMessage({
      type: 'CAPTURE_STATUS',
      sessionId,
      status,
      message,
      progress
    }).catch(() => {
      // Popup may not be listening
    });
  } catch (e) {
    log('Failed to notify popup:', e);
  }
}

/**
 * Message listener
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log('Message received:', message.type);

  if (message.type === 'START_CAPTURE') {
    startCapture(message.config || DEFAULT_CONFIG)
      .then(sessionId => {
        sendResponse({ success: true, sessionId });
      })
      .catch(e => {
        error('Capture error:', e);
        sendResponse({ success: false, error: e.message });
      });
    return true; // Will respond asynchronously
  }

  if (message.type === 'GET_CAPTURE_STATUS') {
    // Return current capture state so popup can resume showing progress
    sendResponse({ captureState: currentCaptureState });
    return true;
  }

  if (message.type === 'GET_CONFIG') {
    chrome.storage.sync.get(DEFAULT_CONFIG, (config) => {
      sendResponse({ config });
    });
    return true;
  }

  if (message.type === 'SET_CONFIG') {
    chrome.storage.sync.set(message.config, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'START_REGION_CAPTURE') {
    startElementSelect()
      .catch(e => {
        error('Failed to start region capture:', e);
        sendResponse({ success: false, error: e.message });
      });
    return true;
  }

  if (message.type === 'ELEMENT_SELECTED') {
    const sessionId = Math.random().toString(36).substring(7);
    log(`Starting element capture session ${sessionId}`);

    (async () => {
      try {
        const tab = await getCurrentTab();
        if (!tab.id) throw new Error('Tab ID not available');

        // Store session
        activeSessions.set(sessionId, {
          tabId: tab.id,
          startTime: Date.now(),
          status: 'element_capture'
        });

        updateCaptureState(sessionId, 'started', 'Starting element capture...');

        // Capture the element
        const stitchResult = await elementCapture(tab.id, message.elementInfo, sessionId);

        // Download the stitched PNG with region suffix
        const hostname = new URL(tab.url || 'https://page').hostname || 'page';
        const tabTitle = sanitizeForFilename(tab.title || '', 40);
        const timestamp = new Date().toISOString().replace(/[^\d]/g, '').substring(0, 14);
        const filename = tabTitle
          ? `${tabTitle}_${hostname}_${timestamp}_region.png`
          : `capture_${hostname}_${timestamp}_region.png`;

        updateCaptureState(sessionId, 'downloading', 'Downloading image...');

        await chrome.downloads.download({
          url: stitchResult.pngBlobUrl,
          filename,
          saveAs: false
        });

        // Clean up blob URL
        try {
          if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
            URL.revokeObjectURL(stitchResult.pngBlobUrl);
          }
        } catch (e) {
          log('Could not revoke blob URL (expected in service worker):', e.message);
        }

        updateCaptureState(sessionId, 'completed', 'Element capture complete!', 100);
        log(`Element capture session ${sessionId} completed successfully`);

        // Clear capture state after a short delay
        setTimeout(() => {
          if (currentCaptureState && currentCaptureState.sessionId === sessionId) {
            currentCaptureState = null;
          }
        }, 5000);

      } catch (e) {
        error(`Element capture failed: ${e.message}`);
        updateCaptureState(sessionId, 'error', `Capture failed: ${e.message}`);
      } finally {
        activeSessions.delete(sessionId);
      }
    })();

    sendResponse({ success: true, sessionId });
    return true;
  }

  if (message.type === 'ELEMENT_SELECT_CANCELLED') {
    log('Element selection cancelled by user');
    // Clean up any state if needed
    sendResponse({ success: true });
    return true;
  }

  sendResponse({ error: 'Unknown message type' });
});

// Listen for keyboard shortcut command
chrome.commands.onCommand.addListener(async (command) => {
  log('Command received:', command);

  if (command === 'capture-page') {
    // Check if capture is already in progress
    if (currentCaptureState &&
        currentCaptureState.status !== 'completed' &&
        currentCaptureState.status !== 'error') {
      log('Capture already in progress, ignoring hotkey');
      return;
    }

    // Get config and start capture
    chrome.storage.sync.get(DEFAULT_CONFIG, (config) => {
      startCapture(config);
    });
  }

  if (command === 'capture-element') {
    // Check if capture is already in progress
    if (currentCaptureState &&
        currentCaptureState.status !== 'completed' &&
        currentCaptureState.status !== 'error') {
      log('Capture already in progress, ignoring hotkey');
      return;
    }

    try {
      await startElementSelect();
    } catch (e) {
      error('Failed to start region capture:', e);
    }
  }
});

// Initialize storage with defaults on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_CONFIG, (stored) => {
    const toSet = {};
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      if (!(key in stored)) {
        toSet[key] = value;
      }
    }
    if (Object.keys(toSet).length > 0) {
      chrome.storage.sync.set(toSet);
    }
  });
  log('Extension installed/updated');
});
