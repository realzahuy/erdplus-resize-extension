(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    fontSize: 11,
    autoFit: true,
    showGrid: true,
    horizontalPadding: 12,
    verticalPadding: 8,
    enabled: false
  };

  const NODE_SELECTOR = ".react-flow__node";
  const NO_STYLE = "__ERDPLUS_NO_INLINE_STYLE__";
  const NODE_STYLE_DATA = "erdplusOriginalStyle";
  const NODE_WIDTH_DATA = "erdplusOriginalWidth";
  const NODE_HEIGHT_DATA = "erdplusOriginalHeight";
  const CHILD_STYLE_DATA = "erdplusOriginalChildStyle";

  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let applyTimer = null;
  let isApplying = false;
  let hasExternalCommand = false;
  let pendingObserverApply = false;

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function normalizeSettings(value) {
    return {
      fontSize: clamp(value && value.fontSize, 10, 24, DEFAULT_SETTINGS.fontSize),
      autoFit: value && typeof value.autoFit === "boolean" ? value.autoFit : DEFAULT_SETTINGS.autoFit,
      showGrid: value && typeof value.showGrid === "boolean" ? value.showGrid : DEFAULT_SETTINGS.showGrid,
      horizontalPadding: clamp(value && value.horizontalPadding, 0, 50, DEFAULT_SETTINGS.horizontalPadding),
      verticalPadding: clamp(value && value.verticalPadding, 0, 50, DEFAULT_SETTINGS.verticalPadding),
      enabled: value && typeof value.enabled === "boolean" ? value.enabled : DEFAULT_SETTINGS.enabled
    };
  }

  function getNodes() {
    return Array.from(document.querySelectorAll(NODE_SELECTOR));
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function hasRenderableText(element) {
    if (!isVisible(element)) return false;
    return String(element.textContent || "").replace(/\s+/g, " ").trim().length > 0;
  }

  function getTextElements(node) {
    const elements = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let textNode;

    while ((textNode = walker.nextNode())) {
      if (!String(textNode.nodeValue || "").replace(/\s+/g, " ").trim()) continue;
      const parent = textNode.parentElement;
      if (!parent || parent === node || !hasRenderableText(parent)) continue;
      if (!elements.includes(parent)) elements.push(parent);
    }

    if (!elements.length && hasRenderableText(node)) elements.push(node);
    return elements;
  }

  function getNodeText(node) {
    const source = typeof node.innerText === "string" ? node.innerText : node.textContent;
    return String(source || "")
      .replace(/\u00a0/g, " ")
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function buildCanvasFont(style) {
    if (style.font && style.font !== "normal normal normal 0px / normal serif") {
      return style.font;
    }

    return [style.fontStyle, style.fontVariant, style.fontWeight, `${style.fontSize}/${style.lineHeight}`, style.fontFamily]
      .filter(Boolean)
      .join(" ");
  }

  function getLineHeight(style) {
    const fontSize = parseFloat(style.fontSize) || settings.fontSize;
    if (style.lineHeight === "normal") return fontSize * 1.2;
    return parseFloat(style.lineHeight) || fontSize * 1.2;
  }

  function measureNodeText(node) {
    const textElements = getTextElements(node);
    const lines = getNodeText(node);
    const primaryElement = textElements[0] || node;
    const primaryStyle = getComputedStyle(primaryElement);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    let textWidth = 0;
    let lineHeight = getLineHeight(primaryStyle);
    const elementMeasurements = [];

    if (context) {
      context.font = buildCanvasFont(primaryStyle);
      lines.forEach((line) => {
        textWidth = Math.max(textWidth, context.measureText(line).width);
      });

      // Account for labels rendered with a different child font.
      textElements.forEach((element) => {
        const style = getComputedStyle(element);
        const elementLines = String(element.innerText || element.textContent || "")
          .replace(/\u00a0/g, " ")
          .split(/\r?\n/)
          .map((line) => line.replace(/\s+/g, " ").trim())
          .filter(Boolean);
        context.font = buildCanvasFont(style);
        let elementWidth = 0;
        elementLines.forEach((line) => {
          elementWidth = Math.max(elementWidth, context.measureText(line).width);
          textWidth = Math.max(textWidth, elementWidth);
        });
        lineHeight = Math.max(lineHeight, getLineHeight(style));
        elementMeasurements.push({ element, width: elementWidth, height: getLineHeight(style) * Math.max(elementLines.length, 1) });
      });
    }

    // A DOM range gives a useful fallback for SVG/HTML labels that canvas cannot identify.
    const textBounds = getTextBounds(textElements);
    if (!textWidth && textBounds) textWidth = textBounds.width;

    return {
      text: lines.join("\n"),
      textWidth,
      textHeight: Math.max(lineHeight, lineHeight * Math.max(lines.length, 1)),
      lineHeight,
      textElements,
      textBounds,
      elementMeasurements
    };
  }

  function getTextBounds(textElements) {
    const rects = [];

    textElements.forEach((element) => {
      if (!isVisible(element)) return;
      const range = document.createRange();
      try {
        range.selectNodeContents(element);
        const rect = range.getBoundingClientRect();
        if (rect.width || rect.height) rects.push(rect);
      } catch (error) {
        const rect = element.getBoundingClientRect();
        if (rect.width || rect.height) rects.push(rect);
      }
    });

    if (!rects.length) return null;
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function saveOriginalNodeStyle(node) {
    if (node.dataset[NODE_STYLE_DATA] !== undefined) return;
    node.dataset[NODE_STYLE_DATA] = node.getAttribute("style") || NO_STYLE;
    node.dataset[NODE_WIDTH_DATA] = node.style.width || "";
    node.dataset[NODE_HEIGHT_DATA] = node.style.height || "";
  }

  function saveOriginalChildStyle(element) {
    if (element.dataset[CHILD_STYLE_DATA] !== undefined) return;
    element.dataset[CHILD_STYLE_DATA] = element.getAttribute("style") || NO_STYLE;
  }

  function setERDFontSize(size) {
    let style = document.getElementById("erdplus-font-style");

    if (!style) {
      style = document.createElement("style");
      style.id = "erdplus-font-style";
      document.head.appendChild(style);
    }

    style.textContent = `
      .react-flow__node,
      .react-flow__node * {
        font-size: ${size}px !important;
        line-height: 1.2 !important;
      }
    `;
  }

  function applyFontSize() {
    if (!settings.enabled) return;
    setERDFontSize(settings.fontSize);
  }

  function getLayoutDimensions(node) {
    const style = getComputedStyle(node);
    const width = node.offsetWidth || parseFloat(style.width) || node.getBoundingClientRect().width;
    const height = node.offsetHeight || parseFloat(style.height) || node.getBoundingClientRect().height;
    return {
      width,
      height,
      paddingX: (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0),
      paddingY: (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0),
      borderX: (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0),
      borderY: (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0),
      boxSizing: style.boxSizing
    };
  }

  function cssDimensionForOuterSize(outerSize, current, axis) {
    if (current.boxSizing === "border-box") return outerSize;
    return Math.max(0, outerSize - (axis === "width" ? current.paddingX + current.borderX : current.paddingY + current.borderY));
  }

  function getVisualPadding(node, textBounds) {
    if (!textBounds) return null;
    const nodeRect = node.getBoundingClientRect();
    const scaleX = node.offsetWidth ? nodeRect.width / node.offsetWidth : 1;
    const scaleY = node.offsetHeight ? nodeRect.height / node.offsetHeight : 1;
    return {
      left: (textBounds.left - nodeRect.left) / (scaleX || 1),
      right: (nodeRect.right - textBounds.right) / (scaleX || 1),
      top: (textBounds.top - nodeRect.top) / (scaleY || 1),
      bottom: (nodeRect.bottom - textBounds.bottom) / (scaleY || 1),
      textHeight: textBounds.height / (scaleY || 1),
      nodeHeight: nodeRect.height / (scaleY || 1)
    };
  }

  function autoResizeNode(node) {
    saveOriginalNodeStyle(node);
    const measurement = measureNodeText(node);
    if (!measurement.textWidth) return;

    let dimensions = getLayoutDimensions(node);
    const requiredOuterWidth = measurement.textWidth + settings.horizontalPadding * 2 + dimensions.paddingX + dimensions.borderX;
    const requiredOuterHeight = measurement.textHeight + settings.verticalPadding * 2 + dimensions.paddingY + dimensions.borderY;

    // Width is evaluated first. This prevents a long identifier from unnecessarily increasing height.
    if (dimensions.width + 0.5 < requiredOuterWidth) {
      const width = `${Math.ceil(cssDimensionForOuterSize(requiredOuterWidth, dimensions, "width"))}px`;
      node.style.setProperty("width", width, "important");
      node.style.setProperty("min-width", width, "important");
      dimensions = getLayoutDimensions(node);
    }

    let requiredHeight = requiredOuterHeight;
    const visualPadding = getVisualPadding(node, measurement.textBounds);
    if (
      visualPadding &&
      visualPadding.textHeight < visualPadding.nodeHeight - 2 &&
      Math.min(visualPadding.top, visualPadding.bottom) + 0.5 < settings.verticalPadding
    ) {
      requiredHeight = Math.max(
        requiredHeight,
        dimensions.height + (settings.verticalPadding - Math.min(visualPadding.top, visualPadding.bottom)) * 2
      );
    }

    if (dimensions.height + 0.5 < requiredHeight) {
      const height = `${Math.ceil(cssDimensionForOuterSize(requiredHeight, dimensions, "height"))}px`;
      node.style.setProperty("height", height, "important");
      node.style.setProperty("min-height", height, "important");
    }

    ensureTextChildrenFit(node, measurement);
  }

  function ensureTextChildrenFit(node, measurement) {
    measurement.textElements.forEach((element) => {
      if (element === node || !element.isConnected) return;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const scale = element.offsetWidth ? rect.width / element.offsetWidth : 1;
      const visibleWidth = rect.width / (scale || 1);
      const isClipped = element.scrollWidth > element.clientWidth + 1;
      const elementMeasurement = measurement.elementMeasurements.find((item) => item.element === element);
      const textWidth = elementMeasurement ? elementMeasurement.width : 0;
      const textHeight = elementMeasurement ? elementMeasurement.height : measurement.textHeight;
      const hasFixedWidth = style.width !== "auto" && style.width !== "fit-content" && Number.isFinite(parseFloat(style.width));
      const hasFixedHeight = style.height !== "auto" && style.height !== "fit-content" && Number.isFinite(parseFloat(style.height));

      if (isClipped || (hasFixedWidth && visibleWidth + 1 < textWidth + settings.horizontalPadding * 2)) {
        saveOriginalChildStyle(element);
        element.style.minWidth = `${Math.ceil(textWidth + settings.horizontalPadding * 2)}px`;
        if (style.display === "inline") element.style.display = "inline-block";
      }

      if (element.scrollHeight > element.clientHeight + 1 || (hasFixedHeight && element.clientHeight + 1 < textHeight)) {
        saveOriginalChildStyle(element);
        element.style.minHeight = `${Math.ceil(textHeight + settings.verticalPadding * 2)}px`;
      }
    });
  }

  function autoResizeAllNodes() {
    getNodes().forEach(autoResizeNode);
  }

  function restoreStyleFromData(element, dataKey) {
    const originalStyle = element.dataset[dataKey];
    if (originalStyle === undefined) return;
    if (originalStyle === NO_STYLE) element.removeAttribute("style");
    else element.setAttribute("style", originalStyle);
    delete element.dataset[dataKey];
  }

  function resetNodes() {
    getNodes().forEach((node) => {
      node.querySelectorAll(`[data-${CHILD_STYLE_DATA.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`).forEach((element) => {
        restoreStyleFromData(element, CHILD_STYLE_DATA);
      });
      restoreStyleFromData(node, NODE_STYLE_DATA);
      delete node.dataset[NODE_WIDTH_DATA];
      delete node.dataset[NODE_HEIGHT_DATA];
    });
  }

  function hideERDGrid() {
    let style = document.getElementById("erdplus-grid-style");

    if (!style) {
      style = document.createElement("style");
      style.id = "erdplus-grid-style";
      document.head.appendChild(style);
    }

    style.textContent = `
      .react-flow__background {
        display: none !important;
      }
    `;
  }

  function showERDGrid() {
    const style = document.getElementById("erdplus-grid-style");
    if (style) style.remove();
  }

  function applyGridSetting() {
    if (settings.showGrid) showERDGrid();
    else hideERDGrid();
  }

  function applyCurrentSettings() {
    if (!settings.enabled || isApplying) return;

    isApplying = true;
    try {
      applyFontSize();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            if (settings.autoFit) autoResizeAllNodes();
            applyGridSetting();
          } finally {
            isApplying = false;
            if (pendingObserverApply) {
              pendingObserverApply = false;
              scheduleApply(100);
            }
          }
        });
      });
    } catch (error) {
      isApplying = false;
    }
  }

  function scheduleApply(delay = 80) {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applyCurrentSettings();
    }, delay);
  }

  function containsFlowNode(node) {
    return node.nodeType === Node.ELEMENT_NODE &&
      (node.matches(NODE_SELECTOR) || Boolean(node.querySelector(NODE_SELECTOR)));
  }

  function observeNewNodes() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((records) => {
      const hasRelevantChange = records.some((record) =>
        Array.from(record.addedNodes).some(containsFlowNode) ||
        record.type === "characterData" && Boolean(record.target.parentElement && record.target.parentElement.closest(NODE_SELECTOR))
      );
      if (!hasRelevantChange) return;
      if (isApplying) {
        pendingObserverApply = true;
        return;
      }
      if (!settings.enabled) return;
      if (hasRelevantChange) scheduleApply();
    });

    observer.observe(document.documentElement || document, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function runWithSettings(nextSettings) {
    settings = normalizeSettings(nextSettings);
    scheduleApply(0);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "APPLY_SETTINGS") {
      hasExternalCommand = true;
      runWithSettings(message.settings);
      sendResponse({ ok: true });
    } else if (message && message.type === "RESET_SETTINGS") {
      hasExternalCommand = true;
      clearTimeout(applyTimer);
      resetNodes();
      const fontStyle = document.getElementById("erdplus-font-style");
      if (fontStyle) fontStyle.remove();
      showERDGrid();
      settings = normalizeSettings(message.settings || DEFAULT_SETTINGS);
      sendResponse({ ok: true });
    }
    return true;
  });

  observeNewNodes();
  chrome.storage.sync.get(DEFAULT_SETTINGS, (storedSettings) => {
    settings = normalizeSettings(storedSettings);
    if (!hasExternalCommand && settings.enabled) scheduleApply(0);
  });
})();
