/**
 * Offscreen Document Script
 * Handles stitching captured viewport images into full-page PNG
 */

const DEBUG = false;

function log(...args) {
  if (DEBUG) {
    const formatted = args.map(arg => {
      if (arg instanceof Error) {
        return `${arg.message}\n${arg.stack || ''}`;
      }
      if (typeof arg === 'object' && arg !== null) {
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          return String(arg);
        }
      }
      return arg;
    });
    console.log('[Offscreen]', ...formatted);
  }
}

function error(...args) {
  const formatted = args.map(arg => {
    if (arg instanceof Error) {
      return `${arg.message}\n${arg.stack || ''}`;
    }
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg, null, 2);
      } catch (e) {
        return String(arg);
      }
    }
    return arg;
  });
  console.error('[Offscreen]', ...formatted);
}

/**
 * Sanitize canvas dimension to valid unsigned long
 * OffscreenCanvas requires positive integers in range [1, 32767]
 */
function sanitizeCanvasDimension(value, defaultValue = 800) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  const numValue = Number(value);
  if (isNaN(numValue) || !isFinite(numValue)) {
    return defaultValue;
  }

  let intValue = Math.floor(numValue);

  if (intValue < 1) {
    intValue = defaultValue;
  }

  if (intValue > 32767) {
    intValue = 32767;
  }

  return intValue;
}

/**
 * Load image from data URL
 */
function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

/**
 * Detect sticky header height by comparing top pixels of two captures
 * Returns the height of the duplicate region (sticky header), or 0 if none found
 */
function detectStickyHeaderHeight(img1, img2, offsetX, maxHeight, width) {
  try {
    // Create canvases to extract pixel data
    const canvas1 = new OffscreenCanvas(width, maxHeight);
    const canvas2 = new OffscreenCanvas(width, maxHeight);
    const ctx1 = canvas1.getContext('2d');
    const ctx2 = canvas2.getContext('2d');

    if (!ctx1 || !ctx2) return 0;

    // Draw the cropped regions from both images
    ctx1.drawImage(img1, offsetX, 0, width, maxHeight, 0, 0, width, maxHeight);
    ctx2.drawImage(img2, offsetX, 0, width, maxHeight, 0, 0, width, maxHeight);

    // Get pixel data
    const data1 = ctx1.getImageData(0, 0, width, maxHeight).data;
    const data2 = ctx2.getImageData(0, 0, width, maxHeight).data;

    // Compare row by row to find where they start to differ
    const rowBytes = width * 4; // 4 bytes per pixel (RGBA)
    let stickyHeight = 0;

    for (let row = 0; row < maxHeight; row++) {
      const rowStart = row * rowBytes;
      let rowMatches = true;
      let diffCount = 0;

      // Compare this row's pixels
      for (let i = 0; i < rowBytes; i += 4) {
        const idx = rowStart + i;
        // Allow small differences (anti-aliasing, compression artifacts)
        const diff = Math.abs(data1[idx] - data2[idx]) +
                     Math.abs(data1[idx + 1] - data2[idx + 1]) +
                     Math.abs(data1[idx + 2] - data2[idx + 2]);
        if (diff > 30) { // Threshold for "different"
          diffCount++;
        }
      }

      // If more than 5% of pixels differ, rows don't match
      if (diffCount > (width * 0.05)) {
        break;
      }

      stickyHeight = row + 1;
    }

    // Only return if we found a meaningful sticky header (at least 20px)
    // and it's not the entire comparison region
    if (stickyHeight >= 20 && stickyHeight < maxHeight - 20) {
      log(`Detected sticky header height: ${stickyHeight}px`);
      return stickyHeight;
    }

    return 0;
  } catch (e) {
    error('Failed to detect sticky header:', e);
    return 0;
  }
}

/**
 * Stitch element captures with cropping
 *
 * @param {Array} captures - Array of {dataUrl, viewportHeight, viewportWidth, scrollY, boundingRect, isLastCapture}
 * @param {Object} elementBounds - {width, height, offsetX, offsetY, devicePixelRatio, hasInternalScroll}
 * @param {number} overlapHeight - Overlap in pixels between captures
 * @returns {Promise<Blob>} PNG blob of stitched element
 */
async function stitchElementCaptures(captures, elementBounds, overlapHeight) {
  try {
    log(`Stitching ${captures.length} element captures with cropping`);
    log(`Element bounds:`, elementBounds);

    if (captures.length === 0) {
      throw new Error('No captures to stitch');
    }

    const { width, height, devicePixelRatio, hasInternalScroll } = elementBounds;

    // Scale coordinates by device pixel ratio
    const scaledWidth = Math.round(width * devicePixelRatio);
    const scaledTotalHeight = Math.round(height * devicePixelRatio);
    const scaledOverlapHeight = Math.round(overlapHeight * devicePixelRatio);

    log(`Mode: ${hasInternalScroll ? 'INTERNAL_SCROLL' : 'PAGE_SCROLL'}`);
    log(`Scaled dimensions: ${scaledWidth}x${scaledTotalHeight}`);

    // Load all images with their metadata
    log('Loading all captured images...');
    const images = [];
    for (let i = 0; i < captures.length; i++) {
      log(`Loading capture ${i + 1}/${captures.length}...`);
      const img = await loadImageFromDataUrl(captures[i].dataUrl);

      // Get the bounding rect for this capture (varies in page scroll mode)
      const rect = captures[i].boundingRect || elementBounds;

      images.push({
        img,
        viewportHeight: Math.round(captures[i].viewportHeight * devicePixelRatio),
        viewportWidth: Math.round(captures[i].viewportWidth * devicePixelRatio),
        scrollY: Math.round(captures[i].scrollY * devicePixelRatio),
        // For page scroll mode, each capture may have different offsets
        // Use explicit null/undefined check since 0 is a valid value
        offsetX: Math.round((rect.x !== undefined ? rect.x : elementBounds.offsetX) * devicePixelRatio),
        offsetY: Math.round((rect.y !== undefined ? rect.y : elementBounds.offsetY) * devicePixelRatio),
        captureHeight: Math.round((rect.height || elementBounds.height) * devicePixelRatio),
        isLastCapture: captures[i].isLastCapture
      });
    }

    // For PAGE_SCROLL mode, calculate which element rows each capture covers
    // This is more accurate than using fixed overlap
    if (!hasInternalScroll) {
      for (let i = 0; i < images.length; i++) {
        const image = images[i];
        // Element row visible at top of this capture
        // If offsetY is negative, element is above viewport, so we're seeing rows from -offsetY
        // If offsetY is positive, element starts below viewport top, so we see from row 0
        image.elementRowStart = Math.max(0, -image.offsetY);

        // Element row visible at bottom of this capture
        // The visible element height in the screenshot is: img.height - max(0, offsetY)
        // (subtract the space above the element if it's below viewport top)
        const visibleElementHeight = image.img.height - Math.max(0, image.offsetY);
        image.elementRowEnd = image.elementRowStart + visibleElementHeight;

        // Cap at total element height (scaled)
        image.elementRowEnd = Math.min(image.elementRowEnd, scaledTotalHeight);

        log(`Capture ${i + 1}: shows element rows ${image.elementRowStart} to ${image.elementRowEnd}`);
      }
    }

    // Detect sticky header by comparing first two captures
    // Only for INTERNAL_SCROLL mode - for PAGE_SCROLL, we handle fixed headers
    // by keeping the element at its natural position on the first capture
    let stickyHeaderHeight = 0;
    if (images.length >= 2 && hasInternalScroll) {
      const firstImg = images[0];
      const secondImg = images[1];
      // Compare top 200px (scaled) to detect sticky headers
      const maxCompareHeight = Math.min(200 * devicePixelRatio, firstImg.img.height / 2);
      stickyHeaderHeight = detectStickyHeaderHeight(
        firstImg.img,
        secondImg.img,
        firstImg.offsetX,
        maxCompareHeight,
        scaledWidth
      );
      if (stickyHeaderHeight > 0) {
        log(`Detected sticky header: ${stickyHeaderHeight}px`);
      }
    }

    // Calculate output canvas size
    const outputWidth = sanitizeCanvasDimension(scaledWidth, 800);
    const outputHeight = sanitizeCanvasDimension(scaledTotalHeight, 600);

    log(`Output canvas dimensions: ${outputWidth}x${outputHeight}`);

    // Create output canvas
    log('Creating output canvas...');
    const outputCanvas = new OffscreenCanvas(outputWidth, outputHeight);
    const ctx = outputCanvas.getContext('2d');

    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    // Draw strategy depends on scroll mode
    let currentDestY = 0;
    let elementRowDrawnUpTo = 0; // Track which element rows we've drawn

    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const isFirstCapture = i === 0;

      // Source coordinates in the capture image
      const srcX = Math.max(0, image.offsetX);
      let srcY, srcHeight;

      if (hasInternalScroll) {
        // Internal scroll: element stays in same position, content scrolls inside
        srcY = isFirstCapture ? image.offsetY : image.offsetY + scaledOverlapHeight;
        srcHeight = isFirstCapture ? image.captureHeight : image.captureHeight - scaledOverlapHeight;
      } else {
        // Page scroll: use element row tracking for accurate stitching
        const elementRowStart = image.elementRowStart;
        const elementRowEnd = image.elementRowEnd;

        // How many rows at the start of this capture overlap with what we've already drawn?
        const overlapRows = Math.max(0, elementRowDrawnUpTo - elementRowStart);

        // In the screenshot, the element starts at max(0, offsetY)
        // We need to skip 'overlapRows' of element content
        srcY = Math.max(0, image.offsetY) + overlapRows;

        // Also skip sticky header on non-first captures
        if (!isFirstCapture && stickyHeaderHeight > 0) {
          srcY += stickyHeaderHeight;
        }

        // Calculate how much height to draw
        srcHeight = image.img.height - srcY;

        // Update tracking
        elementRowDrawnUpTo = Math.max(elementRowDrawnUpTo, elementRowEnd);

        log(`Capture ${i + 1}: overlap=${overlapRows}px, stickySkip=${isFirstCapture ? 0 : stickyHeaderHeight}px`);
      }

      // Clamp source dimensions to image bounds
      srcHeight = Math.min(srcHeight, image.img.height - srcY);
      const srcWidth = Math.min(scaledWidth, image.img.width - srcX);

      if (srcHeight <= 0 || srcWidth <= 0) {
        log(`Capture ${i + 1}: Skipping - no visible content (srcHeight=${srcHeight}, srcWidth=${srcWidth})`);
        continue;
      }

      log(`Drawing capture ${i + 1}: src(${srcX}, ${srcY}, ${srcWidth}x${srcHeight}) -> dest(0, ${currentDestY})`);

      ctx.drawImage(
        image.img,
        srcX, srcY, srcWidth, srcHeight,
        0, currentDestY, srcWidth, srcHeight
      );

      currentDestY += srcHeight;
    }

    // Trim canvas to actual content drawn
    if (currentDestY < outputHeight) {
      log(`Trimming canvas from ${outputHeight} to ${currentDestY}`);
      const trimmedCanvas = new OffscreenCanvas(outputWidth, currentDestY);
      const trimmedCtx = trimmedCanvas.getContext('2d');
      trimmedCtx.drawImage(outputCanvas, 0, 0);

      log('Element stitching complete, converting to PNG...');
      const blob = await trimmedCanvas.convertToBlob({ type: 'image/png' });
      log(`Stitched element PNG created: ${blob.size} bytes`);
      return blob;
    }

    log('Element stitching complete, converting to PNG...');

    // Convert to blob
    const blob = await outputCanvas.convertToBlob({ type: 'image/png' });
    log(`Stitched element PNG created: ${blob.size} bytes`);

    return blob;

  } catch (e) {
    error('Failed to stitch element captures:', e);
    throw new Error(`Failed to stitch element captures: ${e.message}`);
  }
}

/**
 * Stitch captured viewport images together
 * @param {Array} captures - Array of capture objects
 * @param {number} overlapHeight - Overlap between captures in pixels
 * @param {boolean} useCustomContainer - Whether captures are from a custom scroll container
 * @param {Object} containerBounds - Bounds of the custom container (if applicable)
 * @param {number} devicePixelRatio - Device pixel ratio for scaling
 */
async function stitchCapturedViewports(captures, overlapHeight, useCustomContainer = false, containerBounds = null, devicePixelRatio = 1) {
  try {
    log(`Stitching ${captures.length} viewport captures with ${overlapHeight}px overlap`);
    log(`Custom container: ${useCustomContainer}, bounds:`, containerBounds);

    if (captures.length === 0) {
      throw new Error('No captures to stitch');
    }

    // Load all images
    log('Loading all captured images...');
    const images = [];
    for (let i = 0; i < captures.length; i++) {
      log(`Loading capture ${i + 1}/${captures.length}...`);
      const img = await loadImageFromDataUrl(captures[i].dataUrl);
      images.push({
        img,
        viewportHeight: captures[i].viewportHeight,
        viewportWidth: captures[i].viewportWidth,
        scrollY: captures[i].scrollY,
        isLastCapture: captures[i].isLastCapture
      });
    }

    // If using a custom container, we need to crop each capture to the container area
    // and stitch only the container content
    if (useCustomContainer && containerBounds) {
      return await stitchCustomContainerCaptures(images, overlapHeight, containerBounds, devicePixelRatio);
    }

    // Detect sticky header by comparing first two captures
    let stickyHeaderHeight = 0;
    if (images.length >= 2) {
      const firstImg = images[0];
      const secondImg = images[1];
      // Compare top 200px to detect sticky headers
      const maxCompareHeight = Math.min(200, firstImg.img.height / 2);
      stickyHeaderHeight = detectStickyHeaderHeight(
        firstImg.img,
        secondImg.img,
        0,
        maxCompareHeight,
        firstImg.img.width
      );
      if (stickyHeaderHeight > 0) {
        log(`Detected sticky header: ${stickyHeaderHeight}px`);
      }
    }

    // Calculate canvas dimensions
    const canvasWidth = images[0].img.width;
    let totalHeight = images[0].img.height; // First capture is full height

    // Each subsequent capture overlaps by overlapHeight, plus any detected sticky header
    for (let i = 1; i < images.length; i++) {
      const newHeight = images[i].img.height - overlapHeight - stickyHeaderHeight;
      totalHeight += newHeight;
    }

    log(`Canvas dimensions: ${canvasWidth}x${totalHeight}`);

    // Validate dimensions
    const sanitizedWidth = sanitizeCanvasDimension(canvasWidth, 800);
    const sanitizedHeight = sanitizeCanvasDimension(totalHeight, 600);

    // Create output canvas
    log('Creating output canvas...');
    const outputCanvas = new OffscreenCanvas(sanitizedWidth, sanitizedHeight);
    const ctx = outputCanvas.getContext('2d');

    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    // Draw images with overlap and sticky header handling
    let currentY = 0;

    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const isFirstCapture = i === 0;

      // For first capture: draw full image
      // For subsequent captures: skip overlap region AND sticky header (both are duplicates)
      const sourceY = isFirstCapture ? 0 : overlapHeight + stickyHeaderHeight;
      const drawHeight = isFirstCapture ? image.img.height : image.img.height - overlapHeight - stickyHeaderHeight;

      log(`Drawing image ${i + 1} at Y=${currentY}, source Y=${sourceY}, height=${drawHeight}, stickySkip=${isFirstCapture ? 0 : stickyHeaderHeight}px`);

      // Draw the image portion (skip overlap + sticky header for non-first captures)
      ctx.drawImage(
        image.img,
        0, sourceY, canvasWidth, drawHeight,
        0, currentY, canvasWidth, drawHeight
      );

      currentY += drawHeight;
    }

    log('Stitching complete, converting to PNG...');

    // Convert to blob
    const blob = await outputCanvas.convertToBlob({ type: 'image/png' });
    log(`Stitched PNG created: ${blob.size} bytes`);

    return blob;

  } catch (e) {
    error('Failed to stitch captures:', e);
    throw new Error(`Failed to stitch captures: ${e.message}`);
  }
}

/**
 * Stitch captures from a custom scroll container (like Jira's .issue-view)
 * Crops each capture to the container bounds before stitching
 */
async function stitchCustomContainerCaptures(images, overlapHeight, containerBounds, devicePixelRatio) {
  try {
    log(`Stitching ${images.length} custom container captures`);
    log(`Container bounds:`, containerBounds);

    // Scale container bounds by device pixel ratio
    const scaledBounds = {
      left: Math.round(containerBounds.left * devicePixelRatio),
      top: Math.round(containerBounds.top * devicePixelRatio),
      width: Math.round(containerBounds.width * devicePixelRatio),
      height: Math.round(containerBounds.height * devicePixelRatio)
    };
    const scaledOverlap = Math.round(overlapHeight * devicePixelRatio);

    log(`Scaled bounds: left=${scaledBounds.left}, top=${scaledBounds.top}, width=${scaledBounds.width}, height=${scaledBounds.height}`);

    // Detect sticky header by comparing the container region of first two captures
    let stickyHeaderHeight = 0;
    if (images.length >= 2) {
      const maxCompareHeight = Math.min(200 * devicePixelRatio, scaledBounds.height / 2);
      stickyHeaderHeight = detectStickyHeaderHeight(
        images[0].img,
        images[1].img,
        scaledBounds.left,
        maxCompareHeight,
        scaledBounds.width
      );
      if (stickyHeaderHeight > 0) {
        log(`Detected sticky header in container: ${stickyHeaderHeight}px`);
      }
    }

    // Calculate total output height
    // First capture: full container height
    // Subsequent captures: container height minus overlap minus sticky header
    let totalHeight = scaledBounds.height;
    for (let i = 1; i < images.length; i++) {
      totalHeight += scaledBounds.height - scaledOverlap - stickyHeaderHeight;
    }

    log(`Total output dimensions: ${scaledBounds.width}x${totalHeight}`);

    // Create output canvas
    const outputWidth = sanitizeCanvasDimension(scaledBounds.width, 800);
    const outputHeight = sanitizeCanvasDimension(totalHeight, 600);

    const outputCanvas = new OffscreenCanvas(outputWidth, outputHeight);
    const ctx = outputCanvas.getContext('2d');

    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    // Draw each cropped capture
    let currentY = 0;

    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const isFirstCapture = i === 0;

      // Source coordinates: crop to container bounds
      const srcX = scaledBounds.left;
      const srcY = isFirstCapture
        ? scaledBounds.top
        : scaledBounds.top + scaledOverlap + stickyHeaderHeight;
      const srcWidth = scaledBounds.width;
      const srcHeight = isFirstCapture
        ? scaledBounds.height
        : scaledBounds.height - scaledOverlap - stickyHeaderHeight;

      // Clamp to image bounds
      const clampedSrcWidth = Math.min(srcWidth, image.img.width - srcX);
      const clampedSrcHeight = Math.min(srcHeight, image.img.height - srcY);

      if (clampedSrcWidth <= 0 || clampedSrcHeight <= 0) {
        log(`Capture ${i + 1}: Skipping - no visible content`);
        continue;
      }

      log(`Drawing capture ${i + 1}: src(${srcX}, ${srcY}, ${clampedSrcWidth}x${clampedSrcHeight}) -> dest(0, ${currentY})`);

      ctx.drawImage(
        image.img,
        srcX, srcY, clampedSrcWidth, clampedSrcHeight,
        0, currentY, clampedSrcWidth, clampedSrcHeight
      );

      currentY += clampedSrcHeight;
    }

    // Trim canvas if needed
    if (currentY < outputHeight && currentY > 0) {
      log(`Trimming canvas from ${outputHeight} to ${currentY}`);
      const trimmedCanvas = new OffscreenCanvas(outputWidth, currentY);
      const trimmedCtx = trimmedCanvas.getContext('2d');
      trimmedCtx.drawImage(outputCanvas, 0, 0);

      const blob = await trimmedCanvas.convertToBlob({ type: 'image/png' });
      log(`Stitched custom container PNG created: ${blob.size} bytes`);
      return blob;
    }

    const blob = await outputCanvas.convertToBlob({ type: 'image/png' });
    log(`Stitched custom container PNG created: ${blob.size} bytes`);
    return blob;

  } catch (e) {
    error('Failed to stitch custom container captures:', e);
    throw new Error(`Failed to stitch custom container captures: ${e.message}`);
  }
}

/**
 * Stitch Jira center-section captures with cropping
 *
 * @param {Array} captures - Array of {dataUrl, viewportHeight, viewportWidth, scrollY, isLastCapture}
 * @param {Object} cropBounds - {left, top, width, height, devicePixelRatio, totalHeight}
 * @param {number} overlapHeight - Overlap in pixels between captures
 * @returns {Promise<Blob>} PNG blob of stitched center section
 */
async function stitchJiraCenterCaptures(captures, cropBounds, overlapHeight) {
  try {
    log(`Stitching ${captures.length} Jira center captures with cropping`);
    log(`Crop bounds:`, cropBounds);

    if (captures.length === 0) {
      throw new Error('No captures to stitch');
    }

    const { left, top, width, height, devicePixelRatio } = cropBounds;

    // Scale coordinates by device pixel ratio
    const scaledLeft = Math.round(left * devicePixelRatio);
    const scaledTop = Math.round(top * devicePixelRatio);
    const scaledWidth = Math.round(width * devicePixelRatio);
    const scaledHeight = Math.round(height * devicePixelRatio); // Height of each viewport's center
    const scaledOverlapHeight = Math.round(overlapHeight * devicePixelRatio);

    log(`Scaled dimensions: crop at (${scaledLeft}, ${scaledTop}), size ${scaledWidth}x${scaledHeight}`);

    // Load all images
    log('Loading all captured images...');
    const images = [];
    for (let i = 0; i < captures.length; i++) {
      log(`Loading capture ${i + 1}/${captures.length}...`);
      const img = await loadImageFromDataUrl(captures[i].dataUrl);
      images.push({
        img,
        scrollY: Math.round(captures[i].scrollY * devicePixelRatio),
        isLastCapture: captures[i].isLastCapture
      });
    }

    // Calculate actual output height based on captures
    // First capture: full viewport height, subsequent captures: minus overlap
    let calculatedTotalHeight = scaledHeight; // First capture
    for (let i = 1; i < images.length; i++) {
      calculatedTotalHeight += scaledHeight - scaledOverlapHeight;
    }

    log(`Calculated total height from ${captures.length} captures: ${calculatedTotalHeight}`);

    // Calculate output canvas size
    const outputWidth = sanitizeCanvasDimension(scaledWidth, 800);
    const outputHeight = sanitizeCanvasDimension(calculatedTotalHeight, 600);

    log(`Output canvas dimensions: ${outputWidth}x${outputHeight}`);

    // Create output canvas
    log('Creating output canvas...');
    const outputCanvas = new OffscreenCanvas(outputWidth, outputHeight);
    const ctx = outputCanvas.getContext('2d');

    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    // Draw each cropped viewport
    let currentDestY = 0;

    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const isFirstCapture = i === 0;

      // Source coordinates in the capture image (crop to center section)
      const srcX = scaledLeft;
      let srcY = scaledTop;
      let srcHeight = scaledHeight;

      // For subsequent captures, skip the overlap region
      if (!isFirstCapture) {
        srcY += scaledOverlapHeight;
        srcHeight -= scaledOverlapHeight;
      }

      // Clamp source dimensions to image bounds
      srcHeight = Math.min(srcHeight, image.img.height - srcY);
      const srcWidth = Math.min(scaledWidth, image.img.width - srcX);

      if (srcHeight <= 0 || srcWidth <= 0) {
        log(`Capture ${i + 1}: Skipping - no visible content`);
        continue;
      }

      log(`Drawing capture ${i + 1}: src(${srcX}, ${srcY}, ${srcWidth}x${srcHeight}) -> dest(0, ${currentDestY})`);

      ctx.drawImage(
        image.img,
        srcX, srcY, srcWidth, srcHeight,
        0, currentDestY, srcWidth, srcHeight
      );

      currentDestY += srcHeight;
    }

    log(`Jira center stitching complete, drew ${currentDestY}px of content`);

    // If we didn't fill the whole canvas, trim it
    if (currentDestY < outputHeight && currentDestY > 0) {
      log(`Trimming canvas from ${outputHeight} to ${currentDestY}`);
      const trimmedCanvas = new OffscreenCanvas(outputWidth, currentDestY);
      const trimmedCtx = trimmedCanvas.getContext('2d');
      trimmedCtx.drawImage(outputCanvas, 0, 0);

      const blob = await trimmedCanvas.convertToBlob({ type: 'image/png' });
      log(`Stitched Jira center PNG created: ${blob.size} bytes`);
      return blob;
    }

    // Convert to blob
    const blob = await outputCanvas.convertToBlob({ type: 'image/png' });
    log(`Stitched Jira center PNG created: ${blob.size} bytes`);

    return blob;

  } catch (e) {
    error('Failed to stitch Jira center captures:', e);
    throw new Error(`Failed to stitch Jira center captures: ${e.message}`);
  }
}

/**
 * Handle message from background
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log(`Received message type: ${message?.type || 'undefined'}`);

  if (message.type === 'STITCH_CAPTURES') {
    log('Processing STITCH_CAPTURES request');
    log('Custom container:', message.useCustomContainer, 'bounds:', message.containerBounds);

    stitchCapturedViewports(
      message.captures,
      message.overlapHeight,
      message.useCustomContainer,
      message.containerBounds,
      message.devicePixelRatio || 1
    )
      .then((blob) => {
        const pngBlobUrl = URL.createObjectURL(blob);
        log('Sending stitched PNG blob URL');
        sendResponse({
          success: true,
          pngBlobUrl: pngBlobUrl
        });
      })
      .catch((e) => {
        error('Stitching failed:', e);
        sendResponse({
          error: e.message || 'Failed to stitch captures'
        });
      });

    return true; // Will respond asynchronously
  }

  if (message.type === 'STITCH_ELEMENT_CAPTURES') {
    log('Processing STITCH_ELEMENT_CAPTURES request');
    log('Message payload:', {
      captureCount: message.captures?.length,
      elementBounds: message.elementBounds,
      overlapHeight: message.overlapHeight
    });

    stitchElementCaptures(message.captures, message.elementBounds, message.overlapHeight)
      .then((blob) => {
        const pngBlobUrl = URL.createObjectURL(blob);
        log('Sending stitched element PNG blob URL');
        sendResponse({
          success: true,
          pngBlobUrl: pngBlobUrl
        });
      })
      .catch((e) => {
        error('Element stitching failed:', e);
        sendResponse({
          error: e.message || 'Failed to stitch element captures'
        });
      });

    return true; // Will respond asynchronously
  }

  if (message.type === 'STITCH_JIRA_CENTER_CAPTURES') {
    log('Processing STITCH_JIRA_CENTER_CAPTURES request');
    log('Message payload:', {
      captureCount: message.captures?.length,
      cropBounds: message.cropBounds,
      overlapHeight: message.overlapHeight
    });

    stitchJiraCenterCaptures(message.captures, message.cropBounds, message.overlapHeight)
      .then((blob) => {
        const pngBlobUrl = URL.createObjectURL(blob);
        log('Sending stitched Jira center PNG blob URL');
        sendResponse({
          success: true,
          pngBlobUrl: pngBlobUrl
        });
      })
      .catch((e) => {
        error('Jira center stitching failed:', e);
        sendResponse({
          error: e.message || 'Failed to stitch Jira center captures'
        });
      });

    return true; // Will respond asynchronously
  }

  log(`Ignoring message type: ${message.type}`);
  return false;
});

console.log('[Offscreen] Document loaded and ready');
