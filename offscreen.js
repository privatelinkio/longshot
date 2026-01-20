/**
 * Offscreen Document Script
 * Handles stitching captured viewport images into full-page PNG
 */

const DEBUG = true;

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
        offsetX: Math.round((rect.x || elementBounds.offsetX) * devicePixelRatio),
        offsetY: Math.round((rect.y || elementBounds.offsetY) * devicePixelRatio),
        captureHeight: Math.round((rect.height || elementBounds.height) * devicePixelRatio),
        isLastCapture: captures[i].isLastCapture
      });
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

    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const isFirstCapture = i === 0;

      // Source coordinates in the capture image
      const srcX = Math.max(0, image.offsetX);
      let srcY, srcHeight;

      if (hasInternalScroll) {
        // Internal scroll: element stays in same position, content scrolls inside
        // Each capture shows different content at the same viewport position
        srcY = isFirstCapture ? image.offsetY : image.offsetY + scaledOverlapHeight;
        srcHeight = isFirstCapture ? image.captureHeight : image.captureHeight - scaledOverlapHeight;
      } else {
        // Page scroll: element moves in viewport as page scrolls
        // The visible portion of the element is at different Y positions
        // For page scroll, offsetY might be negative (element partially above viewport)
        // or positive (element below top of viewport)
        srcY = Math.max(0, image.offsetY);
        const visibleTop = Math.max(0, -image.offsetY); // How much of element is above viewport
        const visibleBottom = Math.min(image.captureHeight, image.img.height - image.offsetY);
        srcHeight = Math.min(image.captureHeight, image.img.height - srcY);

        // Adjust for overlap on non-first captures
        if (!isFirstCapture) {
          srcY += scaledOverlapHeight;
          srcHeight -= scaledOverlapHeight;
        }
      }

      // Clamp source dimensions to image bounds
      srcHeight = Math.min(srcHeight, image.img.height - srcY);
      const srcWidth = Math.min(scaledWidth, image.img.width - srcX);

      if (srcHeight <= 0 || srcWidth <= 0) {
        log(`Capture ${i + 1}: Skipping - no visible content (srcHeight=${srcHeight}, srcWidth=${srcWidth})`);
        continue;
      }

      log(`Drawing capture ${i + 1}: src(${srcX}, ${srcY}, ${srcWidth}x${srcHeight}) -> dest(0, ${currentDestY})`);

      // Draw with overlap blending for non-first captures
      if (!isFirstCapture && scaledOverlapHeight > 0) {
        ctx.globalAlpha = 0.5;
        ctx.drawImage(
          image.img,
          srcX, srcY - scaledOverlapHeight, srcWidth, scaledOverlapHeight,
          0, currentDestY, srcWidth, scaledOverlapHeight
        );
        ctx.globalAlpha = 1.0;
        currentDestY += scaledOverlapHeight;
      }

      // Draw main content
      ctx.drawImage(
        image.img,
        srcX, srcY, srcWidth, srcHeight,
        0, currentDestY, srcWidth, srcHeight
      );

      currentDestY += srcHeight;
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
 */
async function stitchCapturedViewports(captures, overlapHeight) {
  try {
    log(`Stitching ${captures.length} viewport captures with ${overlapHeight}px overlap`);

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

    // Calculate canvas dimensions
    const canvasWidth = images[0].img.width;
    let totalHeight = images[0].img.height; // First capture is full height

    // Each subsequent capture overlaps by overlapHeight
    for (let i = 1; i < images.length; i++) {
      const newHeight = images[i].img.height - overlapHeight;
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

    // Draw images with overlap handling
    let currentY = 0;

    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const drawHeight = i === 0 ? image.img.height : image.img.height - overlapHeight;
      const sourceY = i === 0 ? 0 : overlapHeight;

      log(`Drawing image ${i + 1} at Y=${currentY}, source Y=${sourceY}, height=${drawHeight}`);

      // Use canvas API to composite images with overlap blending
      if (i > 0) {
        // For overlapping region, draw with some opacity for smooth blending
        ctx.globalAlpha = 0.5;
        ctx.drawImage(
          image.img,
          0, sourceY, canvasWidth, overlapHeight,
          0, currentY, canvasWidth, overlapHeight
        );
        ctx.globalAlpha = 1.0;
      }

      // Draw the main part of the image
      ctx.drawImage(
        image.img,
        0, sourceY, canvasWidth, drawHeight - (i > 0 ? overlapHeight : 0),
        0, currentY + (i > 0 ? overlapHeight : 0), canvasWidth, drawHeight - (i > 0 ? overlapHeight : 0)
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
 * Handle message from background
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log(`Received message type: ${message?.type || 'undefined'}`);

  if (message.type === 'STITCH_CAPTURES') {
    log('Processing STITCH_CAPTURES request');

    stitchCapturedViewports(message.captures, message.overlapHeight)
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

  log(`Ignoring message type: ${message.type}`);
  return false;
});

console.log('[Offscreen] Document loaded and ready');
