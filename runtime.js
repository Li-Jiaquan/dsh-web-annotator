/*!
 * DSH Web Annotator — page runtime (v1)
 *
 * Injected into pages served by the DSH web-annotator proxy (host half).
 * Frozen contract: dsh-web-annotator/SPEC.md §3 (postMessage protocol + anchor shape).
 *
 * Pure IIFE. No dependencies, no build step, no page globals besides the
 * #dsh-web-annotator-root overlay host and its open shadow root. All styling
 * lives in a <style> element inside that shadow root; critical geometry is also
 * applied inline so that a target page's CSP (style-src) cannot break the overlay.
 *
 * Sections:
 *   1. tiny utilities
 *   2. overlay DOM (host + shadow root)
 *   3. protocol helpers (post / ready / error)
 *   4. DOM introspection (element -> anchor fields)
 *   5. hit testing / caret / selection
 *   6. anchor building
 *   7. markers + redraw
 *   8. annotation mode + gesture handling
 *   9. parent messages + bootstrap
 */
(function () {
  'use strict';

  var CHANNEL = 'dsh-web-annotator';
  var ROOT_ID = 'dsh-web-annotator-root';
  var MAX_ANNOTATIONS = 500;
  var CLICK_SLOP = 8;
  var MAX_ELEMENT_TEXT = 300;
  var MAX_SELECTED_TEXT = 1000;
  var MAX_ELEMENT_PATH = 8;
  var MAX_SELECTION_RECTS = 200;
  var MAX_NAME = 80;
  var FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif';

  // Re-entrancy guard: never build a second overlay (e.g. script injected twice).
  if (document.getElementById(ROOT_ID)) return;

  /* ================================================================== *
   * 1. tiny utilities
   * ================================================================== */

  function clamp(value, low, high) {
    return value < low ? low : value > high ? high : value;
  }

  function num(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }

  function collapse(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function truncate(value, limit) {
    var s = String(value == null ? '' : value);
    return s.length > limit ? s.slice(0, limit) : s;
  }

  function scrollLeft() {
    if (typeof window.scrollX === 'number') return window.scrollX;
    return window.pageXOffset || 0;
  }

  function scrollTop() {
    if (typeof window.scrollY === 'number') return window.scrollY;
    return window.pageYOffset || 0;
  }

  function viewportWidth() {
    return Math.round(window.innerWidth || 0);
  }

  function viewportHeight() {
    return Math.round(window.innerHeight || 0);
  }

  function clientRectToViewport(rect) {
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function clientRectToPage(rect) {
    return {
      x: Math.round(rect.left + scrollLeft()),
      y: Math.round(rect.top + scrollTop()),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function viewportRectToPage(rect) {
    return {
      x: Math.round(rect.x + scrollLeft()),
      y: Math.round(rect.y + scrollTop()),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function newId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (error) {
      /* fall through */
    }
    return 'dsha-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function cssEscape(value) {
    try {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
    } catch (error) {
      /* fall through */
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (ch) {
      return '\\' + ch;
    });
  }

  function setAttr(el, name, value) {
    try {
      el.setAttribute(name, String(value));
    } catch (error) {
      /* ignore */
    }
  }

  /* ================================================================== *
   * 2. overlay DOM (host + open shadow root)
   * ================================================================== */

  var HIT_STYLE =
    'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;' +
    'background:transparent;touch-action:none;';

  var BOX_STYLE =
    'position:absolute;display:none;box-sizing:border-box;border:2px solid #2f6fed;' +
    'background:rgba(47,111,237,0.12);border-radius:3px;pointer-events:none;';

  var REGION_BOX_STYLE = BOX_STYLE + 'border-style:dashed;background:rgba(47,111,237,0.08);';

  var FLASH_BOX_STYLE = BOX_STYLE + 'border-width:3px;background:rgba(47,111,237,0.2);';

  var MARKER_STYLE =
    'position:absolute;display:none;width:22px;height:22px;margin:0;padding:0;border:0;' +
    'border-radius:50%;background:#2f6fed;color:#ffffff;' +
    'font:600 12px/22px ' + FONT_STACK + ';' +
    'text-align:center;box-shadow:0 1px 4px rgba(15,23,42,0.4),0 0 0 2px rgba(255,255,255,0.85);' +
    'transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;' +
    'user-select:none;-webkit-user-select:none;touch-action:none;';

  /* v1.2: in-page comment popover + floating action bar (SPEC §11). */
  var POPOVER_STYLE =
    'position:absolute;display:none;box-sizing:border-box;width:300px;max-width:320px;' +
    'padding:12px;background:#ffffff;color:#1f2937;border:1px solid #d7dbe2;border-radius:10px;' +
    'box-shadow:0 10px 28px rgba(15,23,42,0.24),0 2px 8px rgba(15,23,42,0.12);' +
    'pointer-events:auto;z-index:6;text-align:left;';

  var POP_TITLE_STYLE = 'margin:0 0 8px;font:600 13px/1.4 ' + FONT_STACK + ';color:#1f2937;';

  var POP_INPUT_STYLE =
    'display:block;width:100%;box-sizing:border-box;min-height:64px;resize:vertical;' +
    'padding:8px;border:1px solid #c8ccd4;border-radius:8px;background:#ffffff;color:#1f2937;' +
    'font:13px/1.5 ' + FONT_STACK + ';outline:none;';

  var POP_ACTIONS_STYLE = 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px;';

  var POP_BTN_STYLE =
    'font:600 12px/1 ' + FONT_STACK + ';padding:6px 10px;border-radius:6px;cursor:pointer;' +
    'border:1px solid #c8ccd4;background:#eef1f6;color:#1f2937;';

  var POP_PRIMARY_STYLE =
    'font:600 12px/1 ' + FONT_STACK + ';padding:6px 10px;border-radius:6px;cursor:pointer;' +
    'border:1px solid #2f6fed;background:#2f6fed;color:#ffffff;';

  var BAR_STYLE =
    'position:absolute;display:none;left:50%;bottom:16px;transform:translateX(-50%);' +
    'box-sizing:border-box;align-items:center;gap:8px;padding:8px 10px;' +
    'background:#1f2937;color:#ffffff;border-radius:999px;white-space:nowrap;' +
    'box-shadow:0 8px 22px rgba(15,23,42,0.32);pointer-events:auto;z-index:7;';

  var BAR_COUNT_STYLE = 'font:600 12px/1 ' + FONT_STACK + ';opacity:0.92;color:#ffffff;';

  var BAR_SEND_STYLE =
    'font:600 12px/1 ' + FONT_STACK + ';padding:6px 12px;border-radius:999px;border:0;' +
    'background:#2f6fed;color:#ffffff;cursor:pointer;';

  var BAR_CLEAR_STYLE =
    'font:600 12px/1 ' + FONT_STACK + ';padding:6px 10px;border-radius:999px;cursor:pointer;' +
    'border:1px solid rgba(255,255,255,0.4);background:transparent;color:#ffffff;';

  /* v1.3: space-passthrough hint (SPEC §12.1). */
  var HINT_STYLE =
    'position:absolute;top:12px;left:50%;transform:translateX(-50%);display:none;' +
    'box-sizing:border-box;max-width:80%;padding:8px 14px;background:rgba(31,41,55,0.88);' +
    'color:#ffffff;border-radius:999px;white-space:nowrap;pointer-events:none;' +
    'box-shadow:0 6px 18px rgba(15,23,42,0.28);z-index:8;font:600 12px/1 ' + FONT_STACK + ';';

  var STYLE_TEXT = [
    ':host {',
    '  position: fixed; top: 0; left: 0; right: 0; bottom: 0;',
    '  width: 100%; height: 100%; margin: 0; padding: 0; border: 0;',
    '  z-index: 2147483647; display: block; pointer-events: none;',
    '  background: transparent; visibility: visible; opacity: 1;',
    '  font-family: ' + FONT_STACK + ';',
    '  font-size: 13px; line-height: 1.4; direction: ltr; text-align: left;',
    '  color-scheme: light dark;',
    '}',
    '.dsha-hit { position: absolute; left: 0; top: 0; width: 100%; height: 100%;',
    '  pointer-events: none; background: transparent; touch-action: none; }',
    '.dsha-hit.is-active { pointer-events: auto; cursor: crosshair; }',
    '.dsha-visual { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; }',
    '.dsha-box { position: absolute; display: none; box-sizing: border-box;',
    '  border: 2px solid #2f6fed; background: rgba(47,111,237,0.12); border-radius: 3px;',
    '  pointer-events: none; }',
    '.dsha-box.is-on { display: block; }',
    '.dsha-box.is-region { border-style: dashed; background: rgba(47,111,237,0.08); }',
    '.dsha-box.is-flash { border-width: 3px; background: rgba(47,111,237,0.2);',
    '  animation: dsha-flash 0.42s ease-in-out 3; }',
    '@keyframes dsha-flash {',
    '  0% { opacity: 0.2; } 50% { opacity: 1; } 100% { opacity: 0.2; }',
    '}',
    '.dsha-markers { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; }',
    '.dsha-marker { position: absolute; display: none; width: 22px; height: 22px;',
    '  margin: 0; padding: 0; border: 0; border-radius: 50%; background: #2f6fed; color: #ffffff;',
    '  font: 600 12px/22px ' + FONT_STACK + ';',
    '  text-align: center; box-shadow: 0 1px 4px rgba(15,23,42,0.4), 0 0 0 2px rgba(255,255,255,0.85);',
    '  transform: translate(-50%,-50%); pointer-events: auto; cursor: pointer;',
    '  user-select: none; -webkit-user-select: none; touch-action: none; white-space: nowrap; overflow: hidden; }',
    '.dsha-marker.is-on { display: block; }',
    '.dsha-marker.is-hover { background: #1d4ed8; transform: translate(-50%,-50%) scale(1.15); }',
    '.dsha-marker.is-commented { background: #16a34a; }',
    '.dsha-marker.is-commented.is-hover { background: #15803d; }',
    '.dsha-pop { position: absolute; display: none; box-sizing: border-box; width: 300px; max-width: 320px;',
    '  padding: 12px; background: #ffffff; color: #1f2937; border: 1px solid #d7dbe2; border-radius: 10px;',
    '  box-shadow: 0 10px 28px rgba(15,23,42,0.24), 0 2px 8px rgba(15,23,42,0.12);',
    '  pointer-events: auto; z-index: 6; text-align: left; }',
    '.dsha-pop.is-on { display: block; }',
    '.dsha-pop-title { margin: 0 0 8px; font: 600 13px/1.4 ' + FONT_STACK + '; color: #1f2937; }',
    '.dsha-pop-input { display: block; width: 100%; box-sizing: border-box; min-height: 64px;',
    '  resize: vertical; padding: 8px; border: 1px solid #c8ccd4; border-radius: 8px;',
    '  background: #ffffff; color: #1f2937; font: 13px/1.5 ' + FONT_STACK + '; outline: none; }',
    '.dsha-pop-input:focus { border-color: #2f6fed; box-shadow: 0 0 0 2px rgba(47,111,237,0.2); }',
    '.dsha-pop-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }',
    '.dsha-pop button { font: 600 12px/1 ' + FONT_STACK + '; padding: 6px 10px; border-radius: 6px; cursor: pointer; }',
    '.dsha-pop-save { border: 1px solid #2f6fed; background: #2f6fed; color: #ffffff; }',
    '.dsha-pop-delete, .dsha-pop-close { border: 1px solid #c8ccd4; background: #eef1f6; color: #1f2937; }',
    '.dsha-bar { position: absolute; display: none; left: 50%; bottom: 16px; transform: translateX(-50%);',
    '  box-sizing: border-box; align-items: center; gap: 8px; padding: 8px 10px; background: #1f2937;',
    '  color: #ffffff; border-radius: 999px; white-space: nowrap;',
    '  box-shadow: 0 8px 22px rgba(15,23,42,0.32); pointer-events: auto; z-index: 7; }',
    '.dsha-bar.is-on { display: flex; }',
    '.dsha-bar-count { font: 600 12px/1 ' + FONT_STACK + '; opacity: 0.92; }',
    '.dsha-bar button { font: 600 12px/1 ' + FONT_STACK + '; cursor: pointer; }',
    '.dsha-bar-send { padding: 6px 12px; border-radius: 999px; border: 0; background: #2f6fed; color: #ffffff; }',
    '.dsha-bar-send:disabled { opacity: 0.5; cursor: default; }',
    '.dsha-bar-clear { padding: 6px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.4);',
    '  background: transparent; color: #ffffff; }',
    '.dsha-hint { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); display: none;',
    '  box-sizing: border-box; max-width: 80%; padding: 8px 14px; background: rgba(31,41,55,0.88);',
    '  color: #ffffff; border-radius: 999px; white-space: nowrap; pointer-events: none;',
    '  box-shadow: 0 6px 18px rgba(15,23,42,0.28); z-index: 8; font: 600 12px/1 ' + FONT_STACK + '; }',
    '.dsha-hint.is-on { display: block; }',
    ':host(.dsha-passthrough) .dsha-hit,',
    ':host(.dsha-passthrough) .dsha-marker,',
    ':host(.dsha-passthrough) .dsha-pop,',
    ':host(.dsha-passthrough) .dsha-bar,',
    ':host(.dsha-passthrough) .dsha-hint { pointer-events: none !important; }',
    '@media (prefers-reduced-motion: reduce) {',
    '  .dsha-box.is-flash { animation: none; }',
    '  .dsha-marker.is-hover { transform: translate(-50%,-50%); }',
    '}'
  ].join('\n');

  var root = null;
  var shadow = null;
  var hitEl = null;
  var hoverBox = null;
  var regionBox = null;
  var flashBox = null;
  var markersEl = null;
  var popoverEl = null;
  var popTitleEl = null;
  var popInputEl = null;
  var popSaveEl = null;
  var popDeleteEl = null;
  var popCloseEl = null;
  var barEl = null;
  var barCountEl = null;
  var barSendEl = null;
  var barClearEl = null;
  var hintEl = null;

  var state = {
    active: false,
    annotations: [],
    markers: [],
    hoverEl: null,
    hoverMarkerId: null,
    pointer: null,
    drag: null,
    pressedMarker: null,
    pointerRaf: 0,
    redrawRaf: 0,
    flashTimer: 0,
    popoverOpen: false,
    popoverId: null,
    outsideListeners: null,
    passthrough: false
  };

  var activeListeners = null;

  function ensureRoot() {
    var host = document.createElement('div');
    host.id = ROOT_ID;
    setAttr(host, 'data-dsh-web-annotator', '1');
    setAttr(host, 'data-dsh-mode', '0');
    setAttr(host, 'data-dsh-markers', '0');
    // Inline geometry so page CSS (or a CSP that blocks <style>) cannot break the overlay.
    host.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;' +
      'margin:0;padding:0;border:0;z-index:2147483647;display:block;pointer-events:none;' +
      'background:transparent;visibility:visible;opacity:1;';

    var shadowRoot = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.setAttribute('data-dsh-web-annotator', 'style');
    style.textContent = STYLE_TEXT;
    shadowRoot.appendChild(style);

    var hit = document.createElement('div');
    hit.className = 'dsha-hit';
    hit.style.cssText = HIT_STYLE;
    shadowRoot.appendChild(hit);

    var visual = document.createElement('div');
    visual.className = 'dsha-visual';
    visual.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
    shadowRoot.appendChild(visual);

    var hover = document.createElement('div');
    hover.className = 'dsha-box';
    hover.style.cssText = BOX_STYLE;
    visual.appendChild(hover);

    var region = document.createElement('div');
    region.className = 'dsha-box is-region';
    region.style.cssText = REGION_BOX_STYLE;
    visual.appendChild(region);

    var flash = document.createElement('div');
    flash.className = 'dsha-box is-flash';
    flash.style.cssText = FLASH_BOX_STYLE;
    visual.appendChild(flash);

    var markers = document.createElement('div');
    markers.className = 'dsha-markers';
    markers.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
    shadowRoot.appendChild(markers);

    /* v1.2: floating comment popover (opened from a marker). */
    var popover = document.createElement('div');
    popover.className = 'dsha-pop';
    popover.style.cssText = POPOVER_STYLE;
    setAttr(popover, 'data-dsh-popover', '1');

    var popTitle = document.createElement('div');
    popTitle.className = 'dsha-pop-title';
    popTitle.style.cssText = POP_TITLE_STYLE;
    popover.appendChild(popTitle);

    var popInput = document.createElement('textarea');
    popInput.className = 'dsha-pop-input';
    popInput.setAttribute('rows', '3');
    popInput.setAttribute('placeholder', '写下你的修改意见…');
    popInput.style.cssText = POP_INPUT_STYLE;
    popover.appendChild(popInput);

    var popActions = document.createElement('div');
    popActions.className = 'dsha-pop-actions';
    popActions.style.cssText = POP_ACTIONS_STYLE;

    var popSave = document.createElement('button');
    popSave.type = 'button';
    popSave.className = 'dsha-pop-save';
    popSave.textContent = '保存';
    popSave.style.cssText = POP_PRIMARY_STYLE;
    popActions.appendChild(popSave);

    var popDelete = document.createElement('button');
    popDelete.type = 'button';
    popDelete.className = 'dsha-pop-delete';
    popDelete.textContent = '删除';
    popDelete.style.cssText = POP_BTN_STYLE;
    popActions.appendChild(popDelete);

    var popClose = document.createElement('button');
    popClose.type = 'button';
    popClose.className = 'dsha-pop-close';
    popClose.textContent = '关闭';
    popClose.style.cssText = POP_BTN_STYLE;
    popActions.appendChild(popClose);

    popover.appendChild(popActions);
    shadowRoot.appendChild(popover);

    /* v1.2: bottom-center floating action bar. */
    var bar = document.createElement('div');
    bar.className = 'dsha-bar';
    bar.style.cssText = BAR_STYLE;
    setAttr(bar, 'data-dsh-bar', '1');
    setAttr(bar, 'data-dsh-count', '0');

    var barCount = document.createElement('span');
    barCount.className = 'dsha-bar-count';
    barCount.style.cssText = BAR_COUNT_STYLE;
    barCount.textContent = '批注 0 条 · ';
    bar.appendChild(barCount);

    var barSend = document.createElement('button');
    barSend.type = 'button';
    barSend.className = 'dsha-bar-send';
    barSend.textContent = '写入对话框';
    setAttr(barSend, 'title', '写入对话框');
    setAttr(barSend, 'aria-label', '写入对话框');
    barSend.style.cssText = BAR_SEND_STYLE;
    bar.appendChild(barSend);

    var barClear = document.createElement('button');
    barClear.type = 'button';
    barClear.className = 'dsha-bar-clear';
    barClear.textContent = '清空';
    barClear.style.cssText = BAR_CLEAR_STYLE;
    bar.appendChild(barClear);

    shadowRoot.appendChild(bar);

    /* v1.3: space-passthrough hint (pointer-events:none, shadow DOM only). */
    var hint = document.createElement('div');
    hint.className = 'dsha-hint';
    hint.style.cssText = HINT_STYLE;
    hint.textContent = '松开空格键恢复批注模式';
    setAttr(hint, 'data-dsh-hint', '1');
    shadowRoot.appendChild(hint);

    // Keep our UI events inside the overlay: they must never be treated as
    // page gestures and should not bubble into the host page.
    function swallowOverlayEvent(event) {
      try {
        event.stopPropagation();
      } catch (error) {
        /* ignore */
      }
    }

    popover.addEventListener('pointerdown', swallowOverlayEvent);
    popover.addEventListener('pointerup', swallowOverlayEvent);
    popover.addEventListener('click', swallowOverlayEvent);
    bar.addEventListener('pointerdown', swallowOverlayEvent);
    bar.addEventListener('pointerup', swallowOverlayEvent);
    bar.addEventListener('click', swallowOverlayEvent);

    popSave.addEventListener(
      'click',
      guard(function (event) {
        event.preventDefault();
        event.stopPropagation();
        savePopoverComment();
      })
    );
    popDelete.addEventListener(
      'click',
      guard(function (event) {
        event.preventDefault();
        event.stopPropagation();
        deletePopoverAnnotation();
      })
    );
    popClose.addEventListener(
      'click',
      guard(function (event) {
        event.preventDefault();
        event.stopPropagation();
        closePopover();
      })
    );
    barSend.addEventListener(
      'click',
      guard(function (event) {
        event.preventDefault();
        event.stopPropagation();
        submitFromBar();
      })
    );
    barClear.addEventListener(
      'click',
      guard(function (event) {
        event.preventDefault();
        event.stopPropagation();
        clearFromBar();
      })
    );

    var parentNode = document.documentElement || document.body;
    if (parentNode) parentNode.appendChild(host);

    root = host;
    shadow = shadowRoot;
    hitEl = hit;
    hoverBox = hover;
    regionBox = region;
    flashBox = flash;
    markersEl = markers;
    popoverEl = popover;
    popTitleEl = popTitle;
    popInputEl = popInput;
    popSaveEl = popSave;
    popDeleteEl = popDelete;
    popCloseEl = popClose;
    barEl = bar;
    barCountEl = barCount;
    barSendEl = barSend;
    barClearEl = barClear;
    hintEl = hint;
  }

  function showBox(el) {
    if (!el) return;
    try {
      el.style.display = 'block';
      el.classList.add('is-on');
    } catch (error) {
      /* ignore */
    }
  }

  function hideBox(el) {
    if (!el) return;
    try {
      el.style.display = 'none';
      el.classList.remove('is-on');
    } catch (error) {
      /* ignore */
    }
  }

  function positionBox(el, box) {
    if (!el || !box) return;
    el.style.left = Math.round(box.left) + 'px';
    el.style.top = Math.round(box.top) + 'px';
    el.style.width = Math.max(0, Math.round(box.width)) + 'px';
    el.style.height = Math.max(0, Math.round(box.height)) + 'px';
  }

  /* ================================================================== *
   * 3. protocol helpers
   * ================================================================== */

  function post(type, payload) {
    var message = { channel: CHANNEL, type: type };
    if (payload !== undefined) message.payload = payload;
    try {
      // SPEC §3: always post to the parent with targetOrigin '*'.
      window.parent.postMessage(message, '*');
    } catch (error) {
      /* parent unreachable (e.g. detached frame): nothing useful to do */
    }
  }

  function reportError(error) {
    var message;
    try {
      message = error && error.message ? String(error.message) : String(error);
    } catch (inner) {
      message = 'unknown runtime error';
    }
    post('error', { message: truncate(message, 500) });
  }

  function guard(fn) {
    return function guarded() {
      try {
        return fn.apply(this, arguments);
      } catch (error) {
        reportError(error);
        return undefined;
      }
    };
  }

  function postReady() {
    post('ready', {
      url: truncate(targetUrlFromDocument(), 2048),
      title: truncate(String(document.title == null ? '' : document.title), 500)
    });
  }

  /**
   * v1.5 SPEC §14.3: the current target URL (what the parent's address bar
   * shows). Prefer the injected <meta name="dsh-web-annotator-url">, then the
   * proxy's own ?url= parameter (decoded once), then the current location.
   */
  function targetUrlFromDocument() {
    try {
      var meta = document.querySelector('meta[name="dsh-web-annotator-url"]');
      if (meta) {
        var content = meta.getAttribute('content');
        if (content) {
          var trimmed = String(content).replace(/^\s+|\s+$/g, '');
          if (trimmed) return trimmed;
        }
      }
    } catch (error) {
      /* ignore */
    }
    try {
      var search = window.location && window.location.search ? String(window.location.search) : '';
      var match = /[?&]url=([^&]*)/.exec(search);
      if (match && match[1]) {
        try {
          var decoded = decodeURIComponent(match[1]);
          if (decoded) return decoded;
        } catch (decodeError) {
          return match[1];
        }
      }
    } catch (error) {
      /* ignore */
    }
    try {
      return String(window.location.href);
    } catch (error) {
      return '';
    }
  }

  /* ------------------------------------------------------------------ *
   * v1.5 navigation bridge (SPEC §14.3): keep in-page links inside the
   * proxy so the parent can reload the iframe at the new target URL.
   * ------------------------------------------------------------------ */

  function postNavigate(url, source) {
    if (!url) return;
    postTop('navigate', {
      url: truncate(String(url), 2048),
      source: source === 'window-open' ? 'window-open' : 'link'
    });
  }

  /**
   * Resolve a raw href / window.open argument to an absolute http(s) URL, else null.
   *
   * v1.8 SPEC §16.3: /proxy now injects a same-origin mirror <base>
   * (/site/<scheme>/<hostport>/), so `anchor.href` resolves to a mirror URL.
   * Resolve the RAW attribute value against the *target* URL instead (meta,
   * then the proxy's ?url=, then location.href) so `navigate` always carries
   * the real target URL.
   */
  function resolveNavigableUrl(raw) {
    if (raw == null) return null;
    var text = String(raw).replace(/^\s+|\s+$/g, '');
    if (!text) return null;
    // Pure in-page hash links and javascript: URLs are not navigations.
    if (text.charAt(0) === '#') return null;
    if (/^javascript:/i.test(text)) return null;
    var baseUrl = '';
    try {
      baseUrl = targetUrlFromDocument();
    } catch (error) {
      baseUrl = '';
    }
    if (!baseUrl) {
      try {
        baseUrl = String(window.location.href);
      } catch (error) {
        baseUrl = '';
      }
    }
    try {
      var resolved = new URL(text, baseUrl || undefined);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
      return resolved.href;
    } catch (error) {
      return null;
    }
  }

  /**
   * Document capture click: intercept <a href> navigations unless annotation
   * mode (and not Space-passthrough) is turning the click into a selection.
   */
  function onDocumentClickCapture(event) {
    try {
      if (!event || event.defaultPrevented) return;
      var target = event.target;
      if (typeof event.composedPath === 'function') {
        var path = event.composedPath();
        if (path && path.length > 0) target = path[0];
      }
      if (!target || target.nodeType !== 1) return;
      var anchor = typeof target.closest === 'function' ? target.closest('a[href]') : null;
      if (!anchor) return;
      var url = resolveNavigableUrl(anchor.getAttribute('href'));
      if (!url) return;
      // Annotation mode (unless Space-passthrough) keeps the click as a gesture.
      if (state.active && !state.passthrough) return;
      try {
        event.preventDefault();
      } catch (error) {
        /* ignore */
      }
      try {
        event.stopImmediatePropagation();
      } catch (error) {
        /* ignore */
      }
      postNavigate(url, 'link');
    } catch (error) {
      /* never let link handling break the page */
    }
  }

  /** v1.5: window.open(http(s)) is routed to the parent instead of escaping the proxy. */
  function installWindowOpenBridge() {
    try {
      var originalOpen = window.open;
      if (typeof originalOpen !== 'function') return;
      window.open = function (url) {
        try {
          var resolved = resolveNavigableUrl(url);
          if (resolved) {
            postNavigate(resolved, 'window-open');
            return null;
          }
        } catch (error) {
          /* fall through to the original implementation */
        }
        return originalOpen.apply(window, arguments);
      };
    } catch (error) {
      /* ignore */
    }
  }

  /* ================================================================== *
   * 4. DOM introspection (element -> anchor fields)
   * ================================================================== */

  function attr(el, name) {
    try {
      if (!el || !el.getAttribute) return null;
      var value = el.getAttribute(name);
      if (value == null) return null;
      var text = String(value).trim();
      return text === '' ? null : truncate(text, 300);
    } catch (error) {
      return null;
    }
  }

  function elementText(el) {
    if (!el) return null;
    var raw = '';
    try {
      raw = el.innerText != null ? String(el.innerText) : String(el.textContent == null ? '' : el.textContent);
    } catch (error) {
      try {
        raw = String(el.textContent == null ? '' : el.textContent);
      } catch (inner) {
        raw = '';
      }
    }
    if (raw.length > 4000) raw = raw.slice(0, 4000);
    var text = collapse(raw);
    return text === '' ? null : truncate(text, MAX_ELEMENT_TEXT);
  }

  function firstLineText(el) {
    if (!el) return null;
    var raw = '';
    try {
      raw = el.innerText != null ? String(el.innerText) : String(el.textContent == null ? '' : el.textContent);
    } catch (error) {
      raw = '';
    }
    if (raw.length > 4000) raw = raw.slice(0, 4000);
    var lines = raw.split(/\r?\n/);
    for (var i = 0; i < lines.length; i += 1) {
      var line = collapse(lines[i]);
      if (line !== '') return truncate(line, MAX_NAME);
    }
    return null;
  }

  function resolveName(el) {
    var labelled = attr(el, 'aria-label') || attr(el, 'alt') || attr(el, 'title');
    if (labelled) return truncate(labelled, MAX_NAME);
    var line = firstLineText(el);
    return line ? truncate(line, MAX_NAME) : null;
  }

  function buildElementPath(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [];
    var current = el;
    var guardCount = 0;
    while (current && current.nodeType === 1 && guardCount < 64) {
      guardCount += 1;
      var part = String(current.tagName || '').toLowerCase();
      if (part === '') break;
      if (current.id) {
        part += '#' + current.id;
      } else {
        try {
          var classList = current.classList;
          if (classList && classList.length > 0) part += '.' + String(classList[0]);
        } catch (error) {
          /* ignore */
        }
      }
      parts.unshift(part);
      if (current === document.documentElement) break;
      current = current.parentElement;
    }
    if (parts.length === 0) return '';
    if (parts.length > MAX_ELEMENT_PATH) {
      return truncate('\u2026 > ' + parts.slice(parts.length - MAX_ELEMENT_PATH).join(' > '), 1000);
    }
    return truncate(parts.join(' > '), 1000);
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    try {
      if (el.id) {
        var idSelector = '#' + cssEscape(el.id);
        try {
          if (document.querySelectorAll(idSelector).length === 1) return truncate(idSelector, 1000);
        } catch (error) {
          /* ignore invalid id selector */
        }
      }
      var parts = [];
      var current = el;
      var guardCount = 0;
      while (current && current.nodeType === 1 && guardCount < 8) {
        guardCount += 1;
        var tag = String(current.tagName || '').toLowerCase();
        if (tag === '') break;
        var part = tag;
        if (current.id) {
          parts.unshift('#' + cssEscape(current.id));
          break;
        }
        var classNames = [];
        try {
          var classList = current.classList;
          if (classList) {
            for (var i = 0; i < classList.length && classNames.length < 2; i += 1) {
              var name = String(classList[i] || '');
              if (name !== '' && !/^dsha-/.test(name)) classNames.push(cssEscape(name));
            }
          }
        } catch (error) {
          classNames = [];
        }
        if (classNames.length > 0) part += '.' + classNames.join('.');
        var parent = current.parentElement;
        if (parent) {
          var sameTag = [];
          try {
            var children = parent.children || [];
            for (var j = 0; j < children.length; j += 1) {
              if (children[j].tagName === current.tagName) sameTag.push(children[j]);
            }
          } catch (error) {
            sameTag = [];
          }
          if (sameTag.length > 1) {
            var index = -1;
            for (var k = 0; k < sameTag.length; k += 1) {
              if (sameTag[k] === current) {
                index = k;
                break;
              }
            }
            if (index >= 0) part += ':nth-of-type(' + (index + 1) + ')';
          }
        }
        parts.unshift(part);
        if (current === document.documentElement) break;
        current = current.parentElement;
      }
      if (parts.length === 0) return null;
      var selector = truncate(parts.join(' > '), 1000);
      try {
        if (document.querySelectorAll(selector).length === 1) return selector;
      } catch (error) {
        /* ignore invalid selector */
      }
      return selector;
    } catch (error) {
      return null;
    }
  }

  function isFixedElement(el) {
    var current = el;
    var guardCount = 0;
    while (current && current.nodeType === 1 && guardCount < 12) {
      guardCount += 1;
      try {
        var style = window.getComputedStyle(current);
        if (style && style.position === 'fixed') return true;
      } catch (error) {
        /* ignore */
      }
      current = current.parentElement;
    }
    return false;
  }

  /* ================================================================== *
   * 5. hit testing / caret / selection
   * ================================================================== */

  /**
   * Run `fn` with every overlay hit-test participant temporarily
   * pointer-events:none, so elementFromPoint()/caretRangeFromPoint() see the
   * real page underneath the interaction layer. Inline toggling (instead of a
   * CSS class) keeps this working even when the page CSP blocks <style>.
   *
   * When the probe point is known, only markers near that point are toggled:
   * they are the only overlay nodes that could win the hit test there, so this
   * stays O(1) for pages with many annotations.
   */
  function withProbe(x, y, fn) {
    var changed = [];
    var hasPoint = typeof x === 'number' && typeof y === 'number';

    function disable(el) {
      if (!el) return;
      try {
        changed.push([el, el.style.pointerEvents]);
        el.style.pointerEvents = 'none';
      } catch (error) {
        /* ignore */
      }
    }

    disable(hitEl);
    disable(popoverEl);
    disable(barEl);
    for (var i = 0; i < state.markers.length; i += 1) {
      var entry = state.markers[i];
      if (hasPoint) {
        var markerX = parseFloat(entry.el.style.left);
        var markerY = parseFloat(entry.el.style.top);
        if (
          isFinite(markerX) &&
          isFinite(markerY) &&
          (Math.abs(markerX - x) > 24 || Math.abs(markerY - y) > 24)
        ) {
          continue;
        }
      }
      disable(entry.el);
    }

    try {
      return fn();
    } finally {
      for (var j = 0; j < changed.length; j += 1) {
        try {
          changed[j][0].style.pointerEvents = changed[j][1];
        } catch (error) {
          /* ignore */
        }
      }
    }
  }

  function elementAt(x, y) {
    var el = null;
    withProbe(x, y, function () {
      try {
        el = document.elementFromPoint(x, y);
      } catch (error) {
        el = null;
      }
    });
    if (el && (el === root || el.nodeType !== 1)) el = null;
    if (!el) {
      // Nothing at that point (e.g. transparent gap): fall back to the document body.
      if (x >= 0 && y >= 0 && x <= viewportWidth() && y <= viewportHeight()) {
        el = document.body || document.documentElement;
      }
    }
    return el;
  }

  function caretAt(x, y) {
    return withProbe(x, y, function () {
      try {
        if (typeof document.caretRangeFromPoint === 'function') {
          return document.caretRangeFromPoint(x, y);
        }
        if (typeof document.caretPositionFromPoint === 'function') {
          var position = document.caretPositionFromPoint(x, y);
          if (!position || !position.offsetNode) return null;
          var range = document.createRange();
          range.setStart(position.offsetNode, position.offset);
          range.collapse(true);
          return range;
        }
      } catch (error) {
        return null;
      }
      return null;
    });
  }

  function clearNativeSelection() {
    try {
      var selection = window.getSelection();
      if (selection && selection.rangeCount > 0) selection.removeAllRanges();
    } catch (error) {
      /* ignore */
    }
  }

  function readSelectedText() {
    try {
      var selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
      var text = String(selection.toString() == null ? '' : selection.toString()).replace(/\u00a0/g, ' ');
      text = text.replace(/[ \t]+\n/g, '\n').trim();
      return text === '' ? null : text;
    } catch (error) {
      return null;
    }
  }

  /** Apply a native document selection from the gesture's start caret to (x, y). */
  function applyTextSelectionVisual(drag) {
    var gesture = drag || state.drag;
    var pointer = state.pointer;
    if (!gesture || !gesture.caret || !pointer) return;
    var current = caretAt(pointer.x, pointer.y);
    if (!current) return;
    var selection = null;
    try {
      selection = window.getSelection();
    } catch (error) {
      return;
    }
    if (!selection) return;
    try {
      if (typeof selection.setBaseAndExtent === 'function') {
        selection.setBaseAndExtent(
          gesture.caret.startContainer,
          gesture.caret.startOffset,
          current.startContainer,
          current.startOffset
        );
      } else {
        var range = document.createRange();
        range.setStart(gesture.caret.startContainer, gesture.caret.startOffset);
        range.setEnd(current.startContainer, current.startOffset);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } catch (error) {
      // Ranges crossing shadow boundaries / detached nodes cannot be selected.
    }
  }

  function elementOfNode(node) {
    var current = node;
    var guardCount = 0;
    while (current && current.nodeType !== 1 && guardCount < 64) {
      current = current.parentNode;
      guardCount += 1;
    }
    return current && current.nodeType === 1 ? current : null;
  }

  function offsetWithin(el, node, offset) {
    if (!el) return 0;
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      range.setEnd(node, offset);
      return String(range.toString()).length;
    } catch (error) {
      return 0;
    }
  }

  /* ================================================================== *
   * 6. anchor building (SPEC §3, field-for-field)
   * ================================================================== */

  function percentPoint(px, py, box) {
    var width = box.width || 1;
    var height = box.height || 1;
    var xPercent = ((px - box.left) / width) * 100;
    var yPercent = ((py - box.top) / height) * 100;
    return {
      xPercent: clamp(Math.round(xPercent), 0, 100),
      yPercent: clamp(Math.round(yPercent), 0, 100)
    };
  }

  function buildAnchor(kind, el, pageRect, viewportRect, point, extra) {
    var extras = extra || {};
    return {
      id: newId(),
      kind: kind,
      pageUrl: truncate(String(window.location.href), 2048),
      frameUrl: null,
      framePath: [],
      title: truncate(String(document.title == null ? '' : document.title), 500),
      tagName: el && el.tagName ? String(el.tagName).toLowerCase() : null,
      role: el ? attr(el, 'role') : null,
      name: el ? resolveName(el) : null,
      selector: el ? buildSelector(el) : null,
      elementPath: el ? buildElementPath(el) : '',
      text: el ? elementText(el) : null,
      rect: pageRect,
      viewportRect: viewportRect,
      point: point || { xPercent: 50, yPercent: 50 },
      isFixed: el ? isFixedElement(el) : false,
      scrollX: Math.round(scrollLeft()),
      scrollY: Math.round(scrollTop()),
      viewport: { width: viewportWidth(), height: viewportHeight() },
      selectedText: extras.selectedText == null ? null : extras.selectedText,
      selectionRects: extras.selectionRects == null ? null : extras.selectionRects,
      textLocator: extras.textLocator == null ? null : extras.textLocator
    };
  }

  function postSelect(anchor) {
    if (!anchor) return;
    post('select', anchor);
  }

  /* ================================================================== *
   * 7. markers + redraw
   * ================================================================== */

  function findAnnotation(id) {
    for (var i = 0; i < state.annotations.length; i += 1) {
      if (state.annotations[i].id === id) return state.annotations[i];
    }
    return null;
  }

  function kindLabel(kind) {
    if (kind === 'region') return '\u533a\u57df';
    if (kind === 'text') return '\u6587\u672c';
    return '\u5143\u7d20';
  }

  function markerTitle(annotation) {
    var text = '#' + annotation.number + ' ' + kindLabel(annotation.kind);
    if (annotation.selectedText) text += ': ' + truncate(collapse(annotation.selectedText), 40);
    if (annotation.comment) text += ' · 已评论';
    return text;
  }

  function markMarkerHover(id, on) {
    for (var i = 0; i < state.markers.length; i += 1) {
      var marker = state.markers[i];
      var shouldHighlight = !!on && marker.annotation.id === id;
      try {
        if (shouldHighlight) marker.el.classList.add('is-hover');
        else marker.el.classList.remove('is-hover');
      } catch (error) {
        /* ignore */
      }
    }
  }

  function setMarkerHover(id) {
    if (id == null) {
      clearMarkerHover();
      return;
    }
    if (state.hoverMarkerId === id) {
      var existing = findAnnotation(id);
      if (existing) positionBox(hoverBox, annotationViewportBox(existing));
      showBox(hoverBox);
      return;
    }
    state.hoverMarkerId = id;
    var annotation = findAnnotation(id);
    if (annotation) {
      positionBox(hoverBox, annotationViewportBox(annotation));
      showBox(hoverBox);
    }
    markMarkerHover(id, true);
    post('marker-hover', { id: id });
  }

  function clearMarkerHover() {
    if (state.hoverMarkerId == null) return;
    state.hoverMarkerId = null;
    markMarkerHover(null, false);
    post('marker-hover', { id: null });
    hideBox(hoverBox);
  }

  function annotationViewportBox(annotation) {
    return {
      left: annotation.rect.x - scrollLeft(),
      top: annotation.rect.y - scrollTop(),
      width: annotation.rect.width,
      height: annotation.rect.height
    };
  }

  function renderMarkers() {
    if (!markersEl) return;
    while (markersEl.firstChild) markersEl.removeChild(markersEl.firstChild);
    state.markers = [];
    for (var i = 0; i < state.annotations.length; i += 1) {
      addMarker(state.annotations[i]);
    }
    setAttr(root, 'data-dsh-markers', String(state.markers.length));
    layoutMarkers();
    updateActionBar();
    syncOverlayPointerEvents();
  }

  function addMarker(annotation) {
    var marker = document.createElement('div');
    marker.className = 'dsha-marker';
    marker.style.cssText = MARKER_STYLE;
    setAttr(marker, 'data-dsha-id', annotation.id);
    setAttr(marker, 'data-number', String(annotation.number));
    setAttr(marker, 'title', markerTitle(annotation));
    marker.textContent = String(annotation.number);
    if (annotation.comment) marker.classList.add('is-commented');

    // Marker interaction also works outside annotation mode (markers are our
    // own 22px UI; everything else on the page keeps receiving events).
    marker.addEventListener(
      'pointerenter',
      guard(function () {
        if (state.active) return;
        setMarkerHover(annotation.id);
      })
    );
    marker.addEventListener(
      'pointerleave',
      guard(function () {
        if (state.active) return;
        clearMarkerHover();
      })
    );
    marker.addEventListener(
      'pointerdown',
      guard(function (event) {
        if (state.active) return;
        try {
          event.stopPropagation();
        } catch (error) {
          /* ignore */
        }
      })
    );
    marker.addEventListener(
      'pointerup',
      guard(function (event) {
        if (state.active) return;
        try {
          event.stopPropagation();
        } catch (error) {
          /* ignore */
        }
      })
    );
    marker.addEventListener(
      'click',
      guard(function (event) {
        try {
          event.preventDefault();
          event.stopPropagation();
        } catch (error) {
          /* ignore */
        }
        if (state.active) return;
        post('marker-click', { id: annotation.id });
        openPopover(annotation.id);
      })
    );

    markersEl.appendChild(marker);
    state.markers.push({ el: marker, annotation: annotation });
  }

  function layoutMarkers() {
    var sx = scrollLeft();
    var sy = scrollTop();
    var vw = viewportWidth();
    var vh = viewportHeight();
    var pad = 12;
    for (var i = 0; i < state.markers.length; i += 1) {
      var entry = state.markers[i];
      var annotation = entry.annotation;
      var rect = annotation.rect;
      var x = rect.x - sx;
      var y = rect.y - sy;
      var visible;
      if (rect.width > 0 || rect.height > 0) {
        visible = x < vw && x + rect.width > 0 && y < vh && y + rect.height > 0;
      } else {
        visible = x > -pad && y > -pad && x < vw + pad && y < vh + pad;
      }
      if (!visible) {
        entry.el.style.display = 'none';
        entry.el.classList.remove('is-on');
        continue;
      }
      var markerX = clamp(x, pad, Math.max(pad, vw - pad));
      var markerY = clamp(y, pad, Math.max(pad, vh - pad));
      entry.el.style.left = markerX + 'px';
      entry.el.style.top = markerY + 'px';
      entry.el.style.display = 'block';
      entry.el.classList.add('is-on');
    }
    layoutPopover();
  }

  function scheduleRedraw() {
    if (state.redrawRaf) return;
    state.redrawRaf = requestAnimationFrame(
      guard(function () {
        state.redrawRaf = 0;
        layoutMarkers();
      })
    );
  }

  function setAnnotations(list) {
    var normalized = [];
    var seen = Object.create(null);
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length && normalized.length < MAX_ANNOTATIONS; i += 1) {
        var raw = list[i];
        if (!raw || typeof raw !== 'object') continue;
        var id = raw.id == null ? '' : truncate(String(raw.id), 200);
        if (id === '' || seen[id]) continue;
        seen[id] = true;
        var rect = raw.rect && typeof raw.rect === 'object' ? raw.rect : {};
        var number = Number(raw.number);
        var existing = findAnnotation(id);
        // v1.2: comments live page-side; the parent restores them through
        // set-annotations. A missing field keeps the local comment so a stale
        // sync can never drop text the user just saved.
        var comment =
          typeof raw.comment === 'string'
            ? truncate(raw.comment, 2000)
            : existing && typeof existing.comment === 'string'
              ? existing.comment
              : '';
        normalized.push({
          id: id,
          number: isFinite(number) ? Math.round(number) : normalized.length + 1,
          kind: raw.kind === 'region' || raw.kind === 'text' ? raw.kind : 'element',
          rect: {
            x: num(rect.x),
            y: num(rect.y),
            width: Math.max(0, num(rect.width)),
            height: Math.max(0, num(rect.height))
          },
          selectedText:
            raw.kind === 'text' && typeof raw.selectedText === 'string'
              ? truncate(raw.selectedText, MAX_SELECTED_TEXT)
              : null,
          comment: comment
        });
      }
    }
    state.annotations = normalized;
    renderMarkers();
    if (state.popoverOpen) {
      var openAnnotation = findAnnotation(state.popoverId);
      if (!openAnnotation) {
        closePopover();
      } else {
        if (popTitleEl) popTitleEl.textContent = kindLabel(openAnnotation.kind) + '批注 ' + openAnnotation.number;
        layoutPopover();
      }
    }
  }

  function focusAnnotation(id) {
    var annotation = findAnnotation(id);
    if (!annotation) return;
    var rect = annotation.rect;
    var vw = viewportWidth();
    var vh = viewportHeight();
    var targetX = Math.max(0, Math.round(rect.x - Math.max(0, (vw - rect.width) / 2)));
    var targetY = Math.max(0, Math.round(rect.y - Math.max(0, (vh - rect.height) / 2)));
    try {
      window.scrollTo({ left: targetX, top: targetY, behavior: 'auto' });
    } catch (error) {
      try {
        window.scrollTo(targetX, targetY);
      } catch (inner) {
        /* ignore */
      }
    }
    scheduleRedraw();
    flashAnnotation(annotation);
    // v1.2: focusing an annotation opens its in-page comment popover.
    openPopover(id);
  }

  function flashAnnotation(annotation) {
    if (!flashBox) return;
    var box = annotationViewportBox(annotation);
    positionBox(flashBox, box);
    showBox(flashBox);
    try {
      flashBox.classList.remove('is-flash');
      // Force a style flush so the animation restarts on repeated focus calls.
      void flashBox.offsetWidth;
      flashBox.classList.add('is-flash');
    } catch (error) {
      /* ignore */
    }
    if (state.flashTimer) {
      try {
        clearTimeout(state.flashTimer);
      } catch (error) {
        /* ignore */
      }
    }
    state.flashTimer = setTimeout(
      guard(function () {
        state.flashTimer = 0;
        hideBox(flashBox);
        try {
          flashBox.classList.remove('is-flash');
        } catch (error) {
          /* ignore */
        }
      }),
      1500
    );
  }

  function clearAll() {
    state.annotations = [];
    closePopover();
    renderMarkers();
    clearMarkerHover();
    state.hoverEl = null;
    hideBox(hoverBox);
    hideBox(regionBox);
    hideBox(flashBox);
    if (state.flashTimer) {
      try {
        clearTimeout(state.flashTimer);
      } catch (error) {
        /* ignore */
      }
      state.flashTimer = 0;
    }
    applyMode(false, true);
  }

  /* ================================================================== *
   * 8. in-page comment popover + floating action bar (v1.2, SPEC §11)
   * ================================================================== */

  /** Post a contract message whose fields live at the top level (SPEC §11.2). */
  function postTop(type, fields) {
    var message = { channel: CHANNEL, type: type };
    if (fields) {
      for (var key in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) message[key] = fields[key];
      }
    }
    try {
      window.parent.postMessage(message, '*');
    } catch (error) {
      /* parent unreachable */
    }
  }

  /** True when the event belongs to our own popover / action bar UI. */
  function overlayUiFromEvent(event) {
    try {
      if (typeof event.composedPath === 'function') {
        var path = event.composedPath();
        for (var i = 0; i < path.length; i += 1) {
          var node = path[i];
          if (node && node.nodeType === 1 && (node === popoverEl || node === barEl)) return node;
        }
      }
    } catch (error) {
      /* ignore */
    }
    return null;
  }

  function updateActionBar() {
    if (!barEl) return;
    var count = state.annotations.length;
    if (barCountEl) barCountEl.textContent = '批注 ' + count + ' 条 · ';
    if (barSendEl) barSendEl.disabled = count === 0;
    setAttr(barEl, 'data-dsh-count', String(count));
    try {
      if (count > 0) {
        barEl.style.display = 'flex';
        barEl.classList.add('is-on');
      } else {
        barEl.style.display = 'none';
        barEl.classList.remove('is-on');
      }
    } catch (error) {
      /* ignore */
    }
    syncOverlayPointerEvents();
  }

  function updateMarkerCommentState(id) {
    var annotation = findAnnotation(id);
    for (var i = 0; i < state.markers.length; i += 1) {
      var entry = state.markers[i];
      if (entry.annotation.id !== id) continue;
      try {
        if (annotation && annotation.comment) entry.el.classList.add('is-commented');
        else entry.el.classList.remove('is-commented');
        entry.el.setAttribute('title', markerTitle(annotation));
      } catch (error) {
        /* ignore */
      }
    }
  }

  function markerElementFor(id) {
    for (var i = 0; i < state.markers.length; i += 1) {
      if (state.markers[i].annotation.id === id) return state.markers[i].el;
    }
    return null;
  }

  /** Position the popover above the marker; flip below / clamp when needed. */
  function layoutPopover() {
    if (!state.popoverOpen || !popoverEl) return;
    var annotation = findAnnotation(state.popoverId);
    if (!annotation) {
      closePopover();
      return;
    }
    var marker = markerElementFor(state.popoverId);
    var vw = viewportWidth();
    var vh = viewportHeight();
    var pad = 8;
    var gap = 12;
    var half = 11;
    var width = popoverEl.offsetWidth || 300;
    var height = popoverEl.offsetHeight || 160;
    var markerX = annotation.rect.x - scrollLeft();
    var markerY = annotation.rect.y - scrollTop();
    if (marker && marker.style.display !== 'none' && marker.style.left !== '' && marker.style.top !== '') {
      var left = parseFloat(marker.style.left);
      var top = parseFloat(marker.style.top);
      if (isFinite(left)) markerX = left;
      if (isFinite(top)) markerY = top;
    }
    var popLeft = markerX - width / 2;
    var popTop = markerY - half - gap - height;
    if (popTop < pad) popTop = markerY + half + gap;
    popLeft = clamp(popLeft, pad, Math.max(pad, vw - width - pad));
    popTop = clamp(popTop, pad, Math.max(pad, vh - height - pad));
    try {
      popoverEl.style.left = Math.round(popLeft) + 'px';
      popoverEl.style.top = Math.round(popTop) + 'px';
      setAttr(popoverEl, 'data-dsh-left', String(Math.round(popLeft)));
      setAttr(popoverEl, 'data-dsh-top', String(Math.round(popTop)));
    } catch (error) {
      /* ignore */
    }
  }

  function openPopover(id) {
    var annotation = findAnnotation(id);
    if (!annotation) return;
    state.popoverId = id;
    state.popoverOpen = true;
    if (popTitleEl) popTitleEl.textContent = kindLabel(annotation.kind) + '批注 ' + annotation.number;
    if (popInputEl) popInputEl.value = annotation.comment || '';
    if (popoverEl) {
      setAttr(popoverEl, 'data-dsha-popover-id', id);
      popoverEl.style.display = 'block';
      popoverEl.classList.add('is-on');
    }
    layoutPopover();
    installPopoverOutsideListeners();
    syncOverlayPointerEvents();
    try {
      if (popInputEl) {
        popInputEl.focus();
        var length = popInputEl.value.length;
        popInputEl.setSelectionRange(length, length);
      }
    } catch (error) {
      /* ignore */
    }
  }

  function closePopover() {
    state.popoverOpen = false;
    state.popoverId = null;
    removePopoverOutsideListeners();
    if (popoverEl) {
      try {
        popoverEl.style.display = 'none';
        popoverEl.classList.remove('is-on');
        popoverEl.removeAttribute('data-dsha-popover-id');
      } catch (error) {
        /* ignore */
      }
    }
  }

  function savePopoverComment() {
    var id = state.popoverId;
    if (!id) return;
    var annotation = findAnnotation(id);
    if (!annotation) {
      closePopover();
      return;
    }
    var value = '';
    try {
      value = popInputEl ? String(popInputEl.value == null ? '' : popInputEl.value) : '';
    } catch (error) {
      value = '';
    }
    value = truncate(value.replace(/\r\n/g, '\n').trim(), 2000);
    annotation.comment = value;
    updateMarkerCommentState(id);
    postTop('annotation-comment', { id: id, comment: value });
    closePopover();
  }

  function deletePopoverAnnotation() {
    var id = state.popoverId;
    if (!id) return;
    if (!findAnnotation(id)) {
      closePopover();
      return;
    }
    postTop('annotation-delete', { id: id });
    state.annotations = state.annotations.filter(function (item) {
      return item.id !== id;
    });
    closePopover();
    renderMarkers();
  }

  function clearFromBar() {
    var ids = state.annotations.map(function (item) {
      return item.id;
    });
    for (var i = 0; i < ids.length; i += 1) postTop('annotation-delete', { id: ids[i] });
    state.annotations = [];
    closePopover();
    clearMarkerHover();
    renderMarkers();
  }

  function submitFromBar() {
    if (state.annotations.length === 0) return;
    postTop('request-submit');
  }

  function onPopoverOutsidePointerDown(event) {
    if (!state.popoverOpen) return;
    if (overlayUiFromEvent(event)) return;
    // In annotation mode onPointerDown closes the popover and swallows the
    // gesture; outside that mode just dismiss it and let the page work.
    if (state.active) return;
    closePopover();
  }

  function onPopoverOutsideKeyDown(event) {
    if (!state.popoverOpen) return;
    if (event.key === 'Escape' || event.key === 'Esc' || event.keyCode === 27) {
      blockEvent(event);
      closePopover();
    }
  }

  function installPopoverOutsideListeners() {
    if (state.outsideListeners) return;
    state.outsideListeners = {
      pointerdown: guard(onPopoverOutsidePointerDown),
      keydown: guard(onPopoverOutsideKeyDown)
    };
    window.addEventListener('pointerdown', state.outsideListeners.pointerdown, true);
    window.addEventListener('keydown', state.outsideListeners.keydown, true);
  }

  function removePopoverOutsideListeners() {
    if (!state.outsideListeners) return;
    window.removeEventListener('pointerdown', state.outsideListeners.pointerdown, true);
    window.removeEventListener('keydown', state.outsideListeners.keydown, true);
    state.outsideListeners = null;
  }

  /* ================================================================== *
   * 9. annotation mode + gesture handling
   * ================================================================== */

  /** Keep every interactive overlay element in sync with mode/passthrough. */
  function syncOverlayPointerEvents() {
    var uiInteractive = !state.passthrough;
    if (hitEl) {
      try {
        hitEl.style.pointerEvents = state.active && !state.passthrough ? 'auto' : 'none';
      } catch (error) {
        /* ignore */
      }
    }
    if (popoverEl) {
      try {
        popoverEl.style.pointerEvents = uiInteractive ? 'auto' : 'none';
      } catch (error) {
        /* ignore */
      }
    }
    if (barEl) {
      try {
        barEl.style.pointerEvents = uiInteractive ? 'auto' : 'none';
      } catch (error) {
        /* ignore */
      }
    }
    for (var i = 0; i < state.markers.length; i += 1) {
      try {
        state.markers[i].el.style.pointerEvents = uiInteractive ? 'auto' : 'none';
      } catch (error) {
        /* ignore */
      }
    }
  }

  function isSpaceKey(event) {
    return event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar';
  }

  /** True when the keyboard event targets an editable control (page or popover). */
  function isEditableTarget(event) {
    try {
      var path = typeof event.composedPath === 'function' ? event.composedPath() : null;
      var target = path && path.length > 0 ? path[0] : event.target;
      if (!target || target.nodeType !== 1) return false;
      var tag = String(target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      if (target.isContentEditable === true) return true;
      try {
        if (typeof target.closest === 'function' && target.closest('[contenteditable="true"]')) return true;
      } catch (error) {
        /* ignore */
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  /** SPEC §12.1: hold Space to hand the page back while annotation mode is on. */
  function enterPassthrough() {
    if (!state.active || state.passthrough) return;
    state.passthrough = true;
    setAttr(root, 'data-dsh-passthrough', '1');
    try {
      root.classList.add('dsha-passthrough');
    } catch (error) {
      /* ignore */
    }
    syncOverlayPointerEvents();
    if (hintEl) {
      hintEl.style.display = 'block';
      hintEl.classList.add('is-on');
    }
    // Cancel anything that was in flight so no gesture leaks into the page.
    state.drag = null;
    state.pressedMarker = null;
    state.pointer = null;
    state.hoverEl = null;
    if (state.pointerRaf) {
      try {
        cancelAnimationFrame(state.pointerRaf);
      } catch (error) {
        /* ignore */
      }
      state.pointerRaf = 0;
    }
    hideBox(hoverBox);
    hideBox(regionBox);
    clearMarkerHover();
  }

  function exitPassthrough() {
    if (!state.passthrough) return;
    state.passthrough = false;
    setAttr(root, 'data-dsh-passthrough', '0');
    try {
      root.classList.remove('dsha-passthrough');
    } catch (error) {
      /* ignore */
    }
    if (hintEl) {
      hintEl.style.display = 'none';
      hintEl.classList.remove('is-on');
    }
    syncOverlayPointerEvents();
  }

  function onKeyUp(event) {
    if (!state.passthrough) return;
    if (isSpaceKey(event)) exitPassthrough();
  }

  function onWindowBlur() {
    if (state.passthrough) exitPassthrough();
  }

  function applyMode(active, ack) {
    var next = !!active;
    state.active = next;
    if (!next && state.passthrough) exitPassthrough();
    setAttr(root, 'data-dsh-mode', next ? '1' : '0');
    if (hitEl) {
      try {
        if (next) {
          hitEl.classList.add('is-active');
          hitEl.style.pointerEvents = 'auto';
          hitEl.style.cursor = 'crosshair';
        } else {
          hitEl.classList.remove('is-active');
          hitEl.style.pointerEvents = 'none';
          hitEl.style.cursor = '';
        }
      } catch (error) {
        /* ignore */
      }
    }
    if (next) {
      installActiveListeners();
    } else {
      removeActiveListeners();
      resetInteraction();
    }
    syncOverlayPointerEvents();
    if (ack) post('mode', { active: next });
  }

  function resetInteraction() {
    state.drag = null;
    state.pointer = null;
    state.hoverEl = null;
    state.pressedMarker = null;
    if (state.pointerRaf) {
      try {
        cancelAnimationFrame(state.pointerRaf);
      } catch (error) {
        /* ignore */
      }
      state.pointerRaf = 0;
    }
    hideBox(hoverBox);
    hideBox(regionBox);
    clearMarkerHover();
  }

  function pathHasRoot(event) {
    try {
      if (typeof event.composedPath === 'function') {
        var path = event.composedPath();
        for (var i = 0; i < path.length; i += 1) {
          if (path[i] === root) return true;
        }
        return false;
      }
    } catch (error) {
      /* ignore */
    }
    return event.target === root;
  }

  function markerIdFromEvent(event) {
    try {
      if (typeof event.composedPath === 'function') {
        var path = event.composedPath();
        for (var i = 0; i < path.length; i += 1) {
          var node = path[i];
          if (node && node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-dsha-id')) {
            return node.getAttribute('data-dsha-id');
          }
        }
      }
    } catch (error) {
      /* ignore */
    }
    return null;
  }

  function blockEvent(event) {
    try {
      event.preventDefault();
    } catch (error) {
      /* ignore */
    }
    try {
      event.stopPropagation();
    } catch (error) {
      /* ignore */
    }
  }

  function onPointerDown(event) {
    if (state.passthrough) return;
    if (!state.active || !pathHasRoot(event)) return;
    // Popover / action bar controls must keep working (text selection, clicks).
    if (overlayUiFromEvent(event)) return;
    var markerId = markerIdFromEvent(event);
    if (state.popoverOpen) {
      // Click outside the popover closes it; clicking another marker reopens.
      if (!markerId) {
        closePopover();
        blockEvent(event);
        return;
      }
      closePopover();
    }
    blockEvent(event);
    if (typeof event.button === 'number' && event.button !== 0 && event.pointerType !== 'touch') return;

    if (markerId) {
      state.pressedMarker = markerId;
      setMarkerHover(markerId);
      return;
    }
    state.pressedMarker = null;

    var x = num(event.clientX);
    var y = num(event.clientY);
    // Never let a stale native selection leak into a new gesture.
    clearNativeSelection();
    var element = elementAt(x, y);
    var caret = event.shiftKey ? null : caretAt(x, y);
    state.drag = {
      x: x,
      y: y,
      shift: !!event.shiftKey,
      el: element,
      caret: caret,
      moved: false,
      lastX: x,
      lastY: y
    };
    state.pointer = { x: x, y: y };
    hideBox(regionBox);
    hideBox(hoverBox);
    try {
      if (hitEl && typeof hitEl.setPointerCapture === 'function' && event.pointerId != null) {
        hitEl.setPointerCapture(event.pointerId);
      }
    } catch (error) {
      // Synthetic events (tests) have no active pointer: capture is optional.
    }
  }

  function onPointerMove(event) {
    if (state.passthrough) return;
    if (!state.active || !pathHasRoot(event)) return;
    if (overlayUiFromEvent(event)) return;
    blockEvent(event);
    var x = num(event.clientX);
    var y = num(event.clientY);
    state.pointer = { x: x, y: y };

    var markerId = markerIdFromEvent(event);
    if (markerId) {
      setMarkerHover(markerId);
      return;
    }
    clearMarkerHover();

    if (state.drag) {
      var dx = x - state.drag.x;
      var dy = y - state.drag.y;
      if (!state.drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) state.drag.moved = true;
      state.drag.lastX = x;
      state.drag.lastY = y;
    }
    schedulePointerFrame();
  }

  function onPointerUp(event) {
    if (state.passthrough) return;
    if (!state.active || !pathHasRoot(event)) return;
    if (overlayUiFromEvent(event)) return;
    blockEvent(event);
    var x = num(event.clientX);
    var y = num(event.clientY);
    state.pointer = { x: x, y: y };
    try {
      if (hitEl && typeof hitEl.releasePointerCapture === 'function' && event.pointerId != null) {
        hitEl.releasePointerCapture(event.pointerId);
      }
    } catch (error) {
      /* ignore */
    }

    if (state.pressedMarker) {
      var markerId = state.pressedMarker;
      state.pressedMarker = null;
      post('marker-click', { id: markerId });
      // v1.2: a marker click opens its in-page comment popover.
      openPopover(markerId);
      return;
    }

    var drag = state.drag;
    state.drag = null;
    hideBox(regionBox);
    if (!drag) return;

    var dx = x - drag.x;
    var dy = y - drag.y;
    var distance = Math.sqrt(dx * dx + dy * dy);

    if (drag.shift) {
      // Shift+drag = region selection; a sub-8px shift gesture counts as a click.
      if (distance < CLICK_SLOP) selectElementAt(drag.x, drag.y);
      else selectRegionAt(drag, x, y);
      return;
    }

    // Drag-selected text has priority over an element click.
    applyTextSelectionVisual(drag);
    var selectedText = readSelectedText();
    if (selectedText) {
      selectTextAt(drag, x, y);
      return;
    }
    if (distance < CLICK_SLOP) {
      selectElementAt(drag.x, drag.y);
      return;
    }
    // Plain drag that selected nothing: intentionally no annotation.
  }

  function onPointerCancel(event) {
    if (state.passthrough) return;
    if (!state.active || !pathHasRoot(event)) return;
    blockEvent(event);
    state.drag = null;
    state.pressedMarker = null;
    hideBox(regionBox);
  }

  function onClickCapture(event) {
    if (state.passthrough) return;
    if (!state.active || !pathHasRoot(event)) return;
    if (overlayUiFromEvent(event)) return;
    blockEvent(event);
  }

  function onContextMenu(event) {
    if (state.passthrough) return;
    if (!state.active || !pathHasRoot(event)) return;
    if (overlayUiFromEvent(event)) return;
    blockEvent(event);
  }

  function onKeyDown(event) {
    if (!state.active) return;
    // While Space-passthrough is on, every key goes straight to the page.
    if (state.passthrough) return;
    if (isSpaceKey(event) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (overlayUiFromEvent(event) || isEditableTarget(event)) return;
      // Do NOT preventDefault: the page keeps its own Space (scroll etc.) behaviour.
      enterPassthrough();
      return;
    }
    if (event.key === 'Escape' || event.key === 'Esc' || event.keyCode === 27) {
      blockEvent(event);
      if (state.popoverOpen) {
        // v1.2: Esc closes the comment popover without leaving annotation mode.
        closePopover();
        return;
      }
      hideBox(hoverBox);
      hideBox(regionBox);
      clearMarkerHover();
      post('escape');
    }
  }

  function schedulePointerFrame() {
    if (state.pointerRaf) return;
    state.pointerRaf = requestAnimationFrame(
      guard(function () {
        state.pointerRaf = 0;
        pointerFrame();
      })
    );
  }

  function pointerFrame() {
    var pointer = state.pointer;
    if (!pointer) return;
    if (state.drag) {
      if (state.drag.shift) updateRegionBox(state.drag, pointer);
      else if (state.drag.moved) applyTextSelectionVisual(state.drag);
      return;
    }
    updateHoverAt(pointer.x, pointer.y);
  }

  function updateHoverAt(x, y) {
    var element = elementAt(x, y);
    state.hoverEl = element;
    if (!element) {
      hideBox(hoverBox);
      return;
    }
    var rect = null;
    try {
      rect = element.getBoundingClientRect();
    } catch (error) {
      rect = null;
    }
    if (!rect) {
      hideBox(hoverBox);
      return;
    }
    positionBox(hoverBox, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    });
    showBox(hoverBox);
  }

  function updateRegionBox(drag, pointer) {
    var left = Math.min(drag.x, pointer.x);
    var top = Math.min(drag.y, pointer.y);
    var width = Math.abs(pointer.x - drag.x);
    var height = Math.abs(pointer.y - drag.y);
    positionBox(regionBox, { left: left, top: top, width: width, height: height });
    showBox(regionBox);
    hideBox(hoverBox);
  }

  function selectElementAt(x, y) {
    var element = elementAt(x, y);
    if (!element) return;
    var clientRect = null;
    try {
      clientRect = element.getBoundingClientRect();
    } catch (error) {
      return;
    }
    if (!clientRect) return;
    var viewportRect = clientRectToViewport(clientRect);
    var pageRect = clientRectToPage(clientRect);
    var point = percentPoint(x, y, {
      left: viewportRect.x,
      top: viewportRect.y,
      width: viewportRect.width,
      height: viewportRect.height
    });
    postSelect(buildAnchor('element', element, pageRect, viewportRect, point, null));
  }

  function selectRegionAt(drag, x, y) {
    var left = Math.min(drag.x, x);
    var top = Math.min(drag.y, y);
    var width = Math.abs(x - drag.x);
    var height = Math.abs(y - drag.y);
    if (width < 2 || height < 2) {
      selectElementAt(drag.x, drag.y);
      return;
    }
    var viewportRect = {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(width),
      height: Math.round(height)
    };
    var pageRect = viewportRectToPage(viewportRect);
    var element = drag.el || elementAt(drag.x, drag.y);
    var point = percentPoint(drag.x, drag.y, {
      left: viewportRect.x,
      top: viewportRect.y,
      width: viewportRect.width,
      height: viewportRect.height
    });
    postSelect(buildAnchor('region', element, pageRect, viewportRect, point, null));
  }

  function selectTextAt(drag, x, y) {
    var selection = null;
    var range = null;
    try {
      selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      range = selection.getRangeAt(0);
    } catch (error) {
      return;
    }
    var text = readSelectedText();
    if (!text) return;

    var startElement = elementOfNode(range.startContainer);
    var endElement = elementOfNode(range.endContainer);

    var selectionRects = [];
    var unionRect = null;
    try {
      var clientRects = range.getClientRects();
      for (var i = 0; i < clientRects.length && selectionRects.length < MAX_SELECTION_RECTS; i += 1) {
        var clientRect = clientRects[i];
        if (!clientRect || (clientRect.width <= 0 && clientRect.height <= 0)) continue;
        selectionRects.push(clientRectToPage(clientRect));
        if (!unionRect) {
          unionRect = {
            left: clientRect.left,
            top: clientRect.top,
            right: clientRect.left + clientRect.width,
            bottom: clientRect.top + clientRect.height
          };
        } else {
          unionRect.left = Math.min(unionRect.left, clientRect.left);
          unionRect.top = Math.min(unionRect.top, clientRect.top);
          unionRect.right = Math.max(unionRect.right, clientRect.left + clientRect.width);
          unionRect.bottom = Math.max(unionRect.bottom, clientRect.top + clientRect.height);
        }
      }
    } catch (error) {
      selectionRects = [];
      unionRect = null;
    }
    if (!unionRect) {
      try {
        var bounds = range.getBoundingClientRect();
        unionRect = {
          left: bounds.left,
          top: bounds.top,
          right: bounds.left + bounds.width,
          bottom: bounds.top + bounds.height
        };
      } catch (error) {
        return;
      }
    }

    var viewportRect = {
      x: Math.round(unionRect.left),
      y: Math.round(unionRect.top),
      width: Math.max(0, Math.round(unionRect.right - unionRect.left)),
      height: Math.max(0, Math.round(unionRect.bottom - unionRect.top))
    };
    var pageRect = viewportRectToPage(viewportRect);
    var point = percentPoint(drag.x, drag.y, {
      left: viewportRect.x,
      top: viewportRect.y,
      width: viewportRect.width,
      height: viewportRect.height
    });
    var textLocator = {
      selector: startElement ? buildSelector(startElement) : null,
      startOffset: offsetWithin(startElement, range.startContainer, range.startOffset),
      endOffset: offsetWithin(endElement, range.endContainer, range.endOffset),
      rangeText: truncate(text, MAX_SELECTED_TEXT)
    };
    postSelect(
      buildAnchor('text', startElement, pageRect, viewportRect, point, {
        selectedText: truncate(text, MAX_SELECTED_TEXT),
        selectionRects: selectionRects.length > 0 ? selectionRects : null,
        textLocator: textLocator
      })
    );
  }

  /* ================================================================== *
   * 9. screenshot capture (v1.1, SPEC §10.3)
   *
   * Parent -> page: { channel, type:'capture-screenshots', requestId, ids, options? }
   * Page -> parent: { channel, type:'screenshots', requestId, items, failed }
   *
   * The client requests bounded areas around annotations (SPEC §17).
   * Older callers can still request the original full-page or crop modes.
   * ================================================================== */

  var H2C_VENDOR_PATH = '/vendor/html2canvas.min.js';
  var H2C_ASSET_PROXY = '/asset?url=';
  var SHOT_PADDING = 12;
  var SHOT_MAX_SIDE = 1400;
  var SHOT_MAX_ITEMS = 12;
  var SHOT_MAX_SINGLE_BYTES = 1.5 * 1024 * 1024;
  var SHOT_MAX_BATCH_BYTES = 8 * 1024 * 1024;
  var SHOT_MAX_RENDER_PIXELS = 24000000;
  var SHOT_MAX_IDS = 1000;

  var AREA_CONTEXT = 48;
  var AREA_MAX_EDGE = 1800;
  var AREA_MAX_REGIONS = 4;
  var AREA_GAP = 8;
  var EMPTY_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  /* Shared annotated PNG budget and styling (SPEC §12.2 / §17). */
  var FULL_MAX_LONG_EDGE = 2400;
  var FULL_MIN_LONG_EDGE = 800;
  var FULL_MAX_BYTES = 3 * 1024 * 1024;
  var FULL_DOWNSCALE_STEP = 0.85;
  var FULL_BORDER_WIDTH = 3;
  var FULL_BADGE_SIZE = 22;
  var FULL_STROKE_COLOR = '#e11d48';
  var FULL_FILL_COLOR = 'rgba(225,29,72,0.08)';
  var FULL_BADGE_COLOR = '#9f1239';
  var FULL_BADGE_TEXT_COLOR = '#ffffff';

  var h2cPromise = null;
  var captureChain = Promise.resolve();

  /**
   * Lazily load /vendor/html2canvas.min.js. The vendor is a UMD bundle: on a page
   * that defines an AMD loader (`window.define.amd`, as baidu.com does) it
   * registers as an AMD module and never sets `window.html2canvas`; and on a
   * `<base href="target">` proxy page a relative fetch would resolve against the
   * target origin. So the primary path fetches the absolute vendor URL and
   * evaluates it with the UMD globals shadowed (forcing the browser-global
   * branch), falling back to a classic script tag when fetch/eval is unavailable
   * or blocked by CSP. The promise (success or failure) is cached.
   */
  function loadHtml2Canvas() {
    if (h2cPromise) return h2cPromise;
    h2cPromise = new Promise(function (resolve, reject) {
      var settled = false;
      function done(fn) {
        if (settled) return;
        if (typeof fn === 'function') {
          settled = true;
          resolve(fn);
          return;
        }
        fail(new Error('html2canvas global missing after load'));
      }
      function fail(error) {
        if (settled) return;
        settled = true;
        reject(error);
      }
      function viaScriptTag() {
        try {
          if (typeof window.html2canvas === 'function') {
            done(window.html2canvas);
            return;
          }
          var script = document.createElement('script');
          script.src = window.location.origin + H2C_VENDOR_PATH;
          script.async = true;
          setAttr(script, 'data-dsh-web-annotator', 'html2canvas');
          script.onload = function () {
            done(window.html2canvas);
          };
          script.onerror = function () {
            try {
              if (script.parentNode) script.parentNode.removeChild(script);
            } catch (removeError) {
              /* ignore */
            }
            fail(new Error('failed to load ' + H2C_VENDOR_PATH));
          };
          var parentNode = document.head || document.documentElement || document.body;
          if (!parentNode) {
            fail(new Error('no document head available'));
            return;
          }
          parentNode.appendChild(script);
        } catch (error) {
          fail(error);
        }
      }
      try {
        if (typeof window.html2canvas === 'function') {
          done(window.html2canvas);
          return;
        }
        if (typeof window.fetch !== 'function' || typeof window.Function !== 'function') {
          viaScriptTag();
          return;
        }
        window
          .fetch(window.location.origin + H2C_VENDOR_PATH, { credentials: 'omit', cache: 'no-store' })
          .then(function (response) {
            if (!response || !response.ok) {
              // The host answered for the vendor URL: a script-tag retry would
              // only duplicate the same response, so fail this attempt.
              fail(new Error('vendor status ' + (response ? response.status : 'unknown')));
              return undefined;
            }
            return response.text();
          })
          .then(function (code) {
            if (code === undefined) return;
            try {
              if (typeof window.html2canvas === 'function') {
                done(window.html2canvas);
                return;
              }
              var runner = new window.Function(
                'define',
                'module',
                'exports',
                'require',
                code + '\n;return typeof window.html2canvas === "function" ? window.html2canvas : undefined;',
              );
              var factory = runner(undefined, undefined, undefined, undefined);
              done(factory || window.html2canvas);
            } catch (evalError) {
              viaScriptTag();
            }
          })
          .catch(function () {
            viaScriptTag();
          });
      } catch (error) {
        fail(error);
      }
    });
    // Every caller handles the rejection; keep the cached promise quiet.
    h2cPromise.catch(function () {});
    return h2cPromise;
  }

  function postScreenshots(requestId, items, failed) {
    var message = {
      channel: CHANNEL,
      type: 'screenshots',
      requestId: requestId,
      items: Array.isArray(items) ? items : [],
      failed: Array.isArray(failed) ? failed : []
    };
    try {
      window.parent.postMessage(message, '*');
    } catch (error) {
      /* parent unreachable: nothing useful to do */
    }
  }

  /**
   * PNG byte count from the dataURL length only: never atob/base64-decode the
   * whole payload (that would allocate another copy of the image). Exact for
   * valid base64 (minus '=' padding bytes).
   */
  function dataUrlBytes(dataUrl) {
    var text = String(dataUrl == null ? '' : dataUrl);
    var comma = text.indexOf(',');
    if (comma < 0) return text.length;
    var payloadLength = text.length - comma - 1;
    var padding = 0;
    if (text.charAt(text.length - 1) === '=') padding += 1;
    if (text.charAt(text.length - 2) === '=') padding += 1;
    return Math.max(0, Math.floor((payloadLength * 3) / 4) - padding);
  }

  /** Drop a large canvas' backing store as soon as it is no longer needed. */
  function releaseCanvas(canvas) {
    if (!canvas) return;
    try {
      canvas.width = 0;
      canvas.height = 0;
    } catch (error) {
      /* ignore */
    }
  }

  function captureNumber(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : fallback;
  }

  function sanitizeCaptureIds(rawIds) {
    var ids = [];
    if (Array.isArray(rawIds)) {
      for (var i = 0; i < rawIds.length && ids.length < SHOT_MAX_IDS; i += 1) {
        var id = rawIds[i];
        ids.push(typeof id === 'string' ? truncate(id, 200) : id == null ? '' : truncate(String(id), 200));
      }
    }
    return ids;
  }

  function idText(value) {
    return typeof value === 'string' ? value : value == null ? '' : String(value);
  }

  function handleCaptureRequest(data) {
    // SPEC §10.3 puts requestId/ids/options at the top level; accept a
    // payload-wrapped variant too so a slightly different caller still works.
    var message = data.payload && typeof data.payload === 'object' ? data.payload : data;
    var requestId = message.requestId == null ? '' : truncate(String(message.requestId), 200);
    var ids = sanitizeCaptureIds(message.ids);
    var options = message.options && typeof message.options === 'object' ? message.options : {};
    if (ids.length === 0) {
      postScreenshots(requestId, [], []);
      return;
    }
    enqueueCapture(requestId, ids, options);
  }

  /** Serialize capture requests so batches cannot compete with one another. */
  function enqueueCapture(requestId, ids, options) {
    captureChain = captureChain
      .then(function () {
        return runCapture(requestId, ids, options);
      })
      .catch(function () {
        var failed = [];
        for (var i = 0; i < ids.length; i += 1) failed.push({ id: idText(ids[i]), error: 'capture-failed' });
        postScreenshots(requestId, [], failed);
      });
  }

  async function runCapture(requestId, ids, options) {
    var items = [];
    var failed = [];
    var plan = [];
    var accepted = 0;
    var mode = options.mode === 'area' || options.mode === 'crop' ? options.mode : 'full';

    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      if (typeof id !== 'string' || id === '') {
        failed.push({ id: idText(id), error: 'invalid-id' });
        continue;
      }
      var annotation = findAnnotation(id);
      if (!annotation) {
        failed.push({ id: id, error: 'unknown-id' });
        continue;
      }
      var rect = annotation.rect;
      if (!rect || !(rect.width >= 1) || !(rect.height >= 1)) {
        failed.push({ id: id, error: 'empty-rect' });
        continue;
      }
      // The 12-image cap only applies to per-annotation crop images.
      if (mode === 'crop' && accepted >= SHOT_MAX_ITEMS) {
        failed.push({ id: id, error: 'max-items' });
        continue;
      }
      accepted += 1;
      plan.push({ id: id, rect: rect, number: annotation.number });
    }

    if (plan.length === 0) {
      postScreenshots(requestId, items, failed);
      return;
    }

    var html2canvasFn = null;
    try {
      html2canvasFn = await loadHtml2Canvas();
    } catch (error) {
      // SPEC §10.3: load failure => every requested id is in failed.
      // eslint-disable-next-line no-console -- temporary acceptance diagnostics
      console.error('[dsh-web-annotator] html2canvas load failed', (error && error.message) || String(error));
      var loadFailed = [];
      for (var f = 0; f < ids.length; f += 1) loadFailed.push({ id: idText(ids[f]), error: 'html2canvas-load-failed' });
      postScreenshots(requestId, [], loadFailed);
      return;
    }

    var docEl = document.documentElement;
    var pageWidth = Math.max(1, Math.ceil(docEl.scrollWidth || 0));
    var pageHeight = Math.max(1, Math.ceil(docEl.scrollHeight || 0));
    var renderScale = captureNumber(options.scale, 1);
    if (!(renderScale > 0)) renderScale = 1;
    renderScale = clamp(renderScale, 0.1, 2);
    if (mode === 'area') {
      var areas = planScreenshotAreas(plan, failed, pageWidth, pageHeight);
      var areaImage = areas.length > 0
        ? await captureScreenshotAreas(html2canvasFn, docEl, areas, failed, renderScale)
        : null;
      if (areaImage) {
        items.push({ id: '__page__', dataUrl: areaImage.dataUrl, width: areaImage.width, height: areaImage.height });
      }
      postScreenshots(requestId, items, failed);
      return;
    }

    var captureStartedAt = Date.now();
    // v1.7: full mode renders directly at the final long-edge budget instead of
    // rendering huge pages at 1x and downsampling afterwards. Output size is
    // unchanged (still <= FULL_MAX_LONG_EDGE), render pixels drop sharply.
    if (mode === 'full') {
      var fullLongEdge = Math.max(pageWidth, pageHeight);
      if (fullLongEdge > FULL_MAX_LONG_EDGE) {
        renderScale = Math.min(renderScale, FULL_MAX_LONG_EDGE / fullLongEdge);
      }
    }
    var renderPixels = pageWidth * pageHeight * renderScale * renderScale;
    if (renderPixels > SHOT_MAX_RENDER_PIXELS) {
      // Safety valve for very tall pages: lower the render scale, not the output size.
      renderScale = Math.max(0.1, Math.sqrt(SHOT_MAX_RENDER_PIXELS / (pageWidth * pageHeight)));
    }

    var canvas = null;
    try {
      canvas = await renderScreenshot(html2canvasFn, docEl, pageWidth, pageHeight, renderScale);
    } catch (error) {
      // eslint-disable-next-line no-console -- temporary acceptance diagnostics
      console.error('[dsh-web-annotator] capture render failed', {
        message: (error && error.message) || String(error),
        pageWidth: pageWidth,
        pageHeight: pageHeight,
        renderScale: renderScale,
        ms: Date.now() - captureStartedAt
      });
      var renderFailed = [];
      for (var r = 0; r < ids.length; r += 1) renderFailed.push({ id: idText(ids[r]), error: 'render-failed' });
      postScreenshots(requestId, [], renderFailed);
      return;
    }

    var canvasWidth = canvas && canvas.width ? canvas.width : 0;
    var canvasHeight = canvas && canvas.height ? canvas.height : 0;
    if (!canvasWidth || !canvasHeight) {
      releaseCanvas(canvas);
      var emptyRender = [];
      for (var e = 0; e < ids.length; e += 1) emptyRender.push({ id: idText(ids[e]), error: 'render-failed' });
      postScreenshots(requestId, [], emptyRender);
      return;
    }
    var scaleX = canvasWidth / pageWidth;
    var scaleY = canvasHeight / pageHeight;

    if (mode === 'full') {
      var fullImage = buildAnnotatedImage(canvas, plan, scaleX, scaleY);
      releaseCanvas(canvas);
      if (!fullImage || fullImage.error) {
        for (var fp = 0; fp < plan.length; fp += 1) {
          failed.push({ id: plan[fp].id, error: (fullImage && fullImage.error) || 'full-render-failed' });
        }
        postScreenshots(requestId, [], failed);
        return;
      }
      items.push({ id: '__page__', dataUrl: fullImage.dataUrl, width: fullImage.width, height: fullImage.height });
      postScreenshots(requestId, items, failed);
      return;
    }

    var maxWidth = clamp(captureNumber(options.maxWidth, SHOT_MAX_SIDE), 1, SHOT_MAX_SIDE);
    var maxHeight = clamp(captureNumber(options.maxHeight, SHOT_MAX_SIDE), 1, SHOT_MAX_SIDE);

    var batchBytes = 0;
    for (var p = 0; p < plan.length; p += 1) {
      var entry = plan[p];
      try {
        var cropped = cropAnnotation(
          canvas,
          entry.rect,
          pageWidth,
          pageHeight,
          scaleX,
          scaleY,
          maxWidth,
          maxHeight,
          batchBytes
        );
        if (!cropped || cropped.error) {
          failed.push({ id: entry.id, error: (cropped && cropped.error) || 'crop-failed' });
          continue;
        }
        batchBytes += cropped.bytes;
        items.push({ id: entry.id, dataUrl: cropped.dataUrl, width: cropped.width, height: cropped.height });
      } catch (error) {
        failed.push({ id: entry.id, error: 'crop-failed' });
      }
    }

    releaseCanvas(canvas);
    postScreenshots(requestId, items, failed);
  }

  /* ------------------------------------------------------------------ *
   * Bounded annotation screenshots (SPEC §17)
   * ------------------------------------------------------------------ */

  function renderScreenshot(render, docEl, width, height, scale, area) {
    return render(docEl, {
      backgroundColor: null,
      scale: scale,
      useCORS: false,
      allowTaint: false,
      logging: false,
      proxy: window.location.origin + H2C_ASSET_PROXY,
      x: area ? area.left : 0,
      y: area ? area.top : 0,
      width: width,
      height: height,
      windowWidth: viewportWidth() || width,
      windowHeight: viewportHeight() || height,
      scrollX: area ? scrollLeft() : 0,
      scrollY: area ? scrollTop() : 0,
      imageTimeout: 4000,
      onclone: area ? function (clone) { hideOutsideScreenshot(clone, area); } : undefined,
      ignoreElements: function (element) {
        return !!(element && element.id === ROOT_ID);
      }
    });
  }

  function planScreenshotAreas(plan, failed, pageWidth, pageHeight) {
    var maxWidth = Math.max(AREA_MAX_EDGE, viewportWidth());
    var maxHeight = Math.max(AREA_MAX_EDGE, viewportHeight());
    var scrollX = scrollLeft();
    var scrollY = scrollTop();
    var areas = [];
    for (var i = 0; i < plan.length; i += 1) {
      var entry = plan[i];
      var rect = entry.rect;
      var left = Math.max(0, rect.x);
      var top = Math.max(0, rect.y);
      var right = Math.min(pageWidth, rect.x + rect.width);
      var bottom = Math.min(pageHeight, rect.y + rect.height);
      if (right - left < 1 || bottom - top < 1) {
        failed.push({ id: entry.id, error: 'empty-rect' });
        continue;
      }

      // For a very large target (such as <main>), keep the portion nearest
      // the current viewport. Small and offscreen targets use their page rects.
      left = Math.floor(Math.max(0, left - AREA_CONTEXT));
      top = Math.floor(Math.max(0, top - AREA_CONTEXT));
      right = Math.ceil(Math.min(pageWidth, right + AREA_CONTEXT));
      bottom = Math.ceil(Math.min(pageHeight, bottom + AREA_CONTEXT));
      if (right - left > maxWidth) {
        left = clamp(scrollX, left, right - maxWidth);
        right = left + maxWidth;
      }
      if (bottom - top > maxHeight) {
        top = clamp(scrollY, top, bottom - maxHeight);
        bottom = top + maxHeight;
      }

      var area = areas.find(function (candidate) {
        return left <= candidate.right && right >= candidate.left &&
          top <= candidate.bottom && bottom >= candidate.top &&
          Math.max(right, candidate.right) - Math.min(left, candidate.left) <= maxWidth &&
          Math.max(bottom, candidate.bottom) - Math.min(top, candidate.top) <= maxHeight;
      });
      if (area) {
        area.left = Math.min(area.left, left);
        area.top = Math.min(area.top, top);
        area.right = Math.max(area.right, right);
        area.bottom = Math.max(area.bottom, bottom);
        area.entries.push(entry);
      } else if (areas.length < AREA_MAX_REGIONS) {
        areas.push({ left: left, top: top, right: right, bottom: bottom, entries: [entry] });
      } else {
        failed.push({ id: entry.id, error: 'max-areas' });
      }
    }
    return areas.sort(function (a, b) { return a.top - b.top || a.left - b.left; });
  }

  /** Stop html2canvas painting unrelated subtrees without changing their layout. */
  function hideOutsideScreenshot(clone, area) {
    var view = clone.defaultView;
    var left = area.left - view.scrollX - AREA_CONTEXT;
    var top = area.top - view.scrollY - AREA_CONTEXT;
    var right = area.right - view.scrollX + AREA_CONTEXT;
    var bottom = area.bottom - view.scrollY + AREA_CONTEXT;
    var nodes = clone.body.querySelectorAll('*');
    var kept = new Set([clone.body]);
    var outside = [];
    for (var i = nodes.length - 1; i >= 0; i -= 1) {
      var node = nodes[i];
      // Keep ancestors of intersecting nodes, including descendants that
      // overflow their parent or are positioned independently of it.
      if (kept.has(node)) {
        kept.add(node.parentElement);
        continue;
      }
      var bounds = node.getBoundingClientRect();
      if (bounds.right > left && bounds.left < right && bounds.bottom > top && bounds.top < bottom) {
        kept.add(node);
        kept.add(node.parentElement);
      } else if (node.style) {
        outside.push(node);
      }
    }
    for (var j = 0; j < outside.length; j += 1) {
      var element = outside[j];
      if (!kept.has(element.parentElement)) continue;
      element.style.setProperty('opacity', '0', 'important');
      // The renderer reads a subtree root's image sources before checking its
      // opacity. Leave the cloned image's actual attributes and layout alone.
      element.style.setProperty('background-image', 'none', 'important');
      if (element.tagName === 'IMG') {
        Object.defineProperty(element, 'currentSrc', { value: EMPTY_GIF });
      }
    }
  }

  async function captureScreenshotAreas(render, docEl, areas, failed, requestedScale) {
    var totalHeight = AREA_GAP * (areas.length - 1);
    var maxWidth = 0;
    for (var i = 0; i < areas.length; i += 1) {
      maxWidth = Math.max(maxWidth, areas[i].right - areas[i].left);
      totalHeight += areas[i].bottom - areas[i].top;
    }
    var scale = Math.min(1, requestedScale, FULL_MAX_LONG_EDGE / Math.max(maxWidth, totalHeight));
    var panels = await Promise.all(areas.map(async function (area) {
      var width = area.right - area.left;
      var height = area.bottom - area.top;
      var canvas = null;
      try {
        canvas = await renderScreenshot(render, docEl, width, height, scale, area);
        if (canvas && canvas.width && canvas.height &&
            drawScreenshotMarks(canvas, area.entries, canvas.width / width, canvas.height / height, area)) {
          return { area: area, canvas: canvas };
        }
      } catch (error) {
        /* Other areas can still be attached. */
      }
      releaseCanvas(canvas);
      for (var entry of area.entries) failed.push({ id: entry.id, error: 'render-failed' });
      return null;
    }));
    panels = panels.filter(Boolean);
    if (panels.length === 0) return null;

    var output = panels[0].canvas;
    try {
      if (panels.length > 1) {
        var gap = Math.floor(AREA_GAP * scale);
        output = document.createElement('canvas');
        output.width = Math.max.apply(null, panels.map(function (panel) { return panel.canvas.width; }));
        output.height = panels.reduce(function (sum, panel) { return sum + panel.canvas.height; }, gap * (panels.length - 1));
        var context = output.getContext('2d');
        if (!context) throw new Error('canvas-unavailable');
        context.fillStyle = '#e5e7eb';
        context.fillRect(0, 0, output.width, output.height);
        var offset = 0;
        for (var panel of panels) {
          context.drawImage(panel.canvas, 0, offset);
          offset += panel.canvas.height + gap;
        }
      }
      var image = encodeAnnotatedPng(output);
      if (!image.error) return image;
      for (var panel of panels) {
        for (var entry of panel.area.entries) failed.push({ id: entry.id, error: image.error });
      }
      return null;
    } finally {
      if (panels.length > 1) releaseCanvas(output);
      for (var panel of panels) releaseCanvas(panel.canvas);
    }
  }

  /** Annotate the render in place, with each badge constrained to its panel. */
  function drawScreenshotMarks(sourceCanvas, plan, scaleX, scaleY, area) {
    var ctx = sourceCanvas.getContext('2d');
    if (!ctx) return false;
    // html2canvas leaves the render transform on the returned context.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    var sourceWidth = sourceCanvas.width;
    var sourceHeight = sourceCanvas.height;
    var outScale = Math.min(1, FULL_MAX_LONG_EDGE / Math.max(sourceWidth, sourceHeight));
    var strokeWidth = FULL_BORDER_WIDTH / outScale;
    var badgeSize = FULL_BADGE_SIZE / outScale;
    var badgeFont = badgeSize * 0.55;
    var originX = area ? area.left : 0;
    var originY = area ? area.top : 0;

    for (var i = 0; i < plan.length; i += 1) {
      var entry = plan[i];
      var x = (entry.rect.x - originX) * scaleX;
      var y = (entry.rect.y - originY) * scaleY;
      var w = entry.rect.width * scaleX;
      var h = entry.rect.height * scaleY;
      if (area) {
        w = Math.min(sourceWidth, x + w) - Math.max(0, x);
        h = Math.min(sourceHeight, y + h) - Math.max(0, y);
        x = Math.max(0, x);
        y = Math.max(0, y);
      }
      if (!(w >= 0.5) || !(h >= 0.5)) continue;
      ctx.fillStyle = FULL_FILL_COLOR;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = FULL_STROKE_COLOR;
      ctx.lineWidth = strokeWidth;
      ctx.strokeRect(x, y, w, h);
      drawFullBadge(ctx, x, y, badgeSize, badgeFont, entry.number, sourceWidth, sourceHeight);
    }
    return true;
  }

  function buildAnnotatedImage(sourceCanvas, plan, scaleX, scaleY) {
    try {
      if (!drawScreenshotMarks(sourceCanvas, plan, scaleX, scaleY)) return { error: 'canvas-unavailable' };
      return encodeAnnotatedPng(sourceCanvas);
    } catch (error) {
      return { error: 'full-render-failed' };
    }
  }

  function encodeAnnotatedPng(sourceCanvas) {
    var outScale = Math.min(1, FULL_MAX_LONG_EDGE / Math.max(sourceCanvas.width, sourceCanvas.height));
    var outWidth = Math.max(1, Math.round(sourceCanvas.width * outScale));
    var outHeight = Math.max(1, Math.round(sourceCanvas.height * outScale));
    var encoded = encodeFull(sourceCanvas, outWidth, outHeight);
    if (encoded.error) return encoded;

    var guard = 0;
    while (encoded.bytes > FULL_MAX_BYTES && guard < 12) {
      guard += 1;
      var nextWidth = Math.floor(encoded.width * FULL_DOWNSCALE_STEP);
      var nextHeight = Math.floor(encoded.height * FULL_DOWNSCALE_STEP);
      if (Math.max(nextWidth, nextHeight) < FULL_MIN_LONG_EDGE) break;
      var retry = encodeFull(sourceCanvas, nextWidth, nextHeight);
      if (retry.error) break;
      encoded = retry;
    }
    return encoded.bytes > FULL_MAX_BYTES ? { error: 'full-image-too-large' } : encoded;
  }

  /** Dark-red rounded badge with the annotation number, top-left of the rect. */
  function drawFullBadge(ctx, x, y, size, fontSize, number, canvasWidth, canvasHeight) {
    var bx = clamp(x, 0, Math.max(0, canvasWidth - size));
    var by = clamp(y, 0, Math.max(0, canvasHeight - size));
    var radius = Math.max(2, size * 0.2);
    ctx.beginPath();
    ctx.moveTo(bx + radius, by);
    ctx.lineTo(bx + size - radius, by);
    ctx.quadraticCurveTo(bx + size, by, bx + size, by + radius);
    ctx.lineTo(bx + size, by + size - radius);
    ctx.quadraticCurveTo(bx + size, by + size, bx + size - radius, by + size);
    ctx.lineTo(bx + radius, by + size);
    ctx.quadraticCurveTo(bx, by + size, bx, by + size - radius);
    ctx.lineTo(bx, by + radius);
    ctx.quadraticCurveTo(bx, by, bx + radius, by);
    ctx.closePath();
    ctx.fillStyle = FULL_BADGE_COLOR;
    ctx.fill();
    ctx.fillStyle = FULL_BADGE_TEXT_COLOR;
    ctx.font = '700 ' + fontSize + 'px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(number), bx + size / 2, by + size / 2);
  }

  function encodeFull(sourceCanvas, width, height) {
    if (sourceCanvas.width !== width || sourceCanvas.height !== height) {
      return encodeCrop(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, width, height);
    }
    try {
      var dataUrl = sourceCanvas.toDataURL('image/png');
      if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/png') !== 0) return { error: 'encode-failed' };
      return { dataUrl: dataUrl, width: width, height: height, bytes: dataUrlBytes(dataUrl) };
    } catch (error) {
      return { error: 'encode-failed' };
    }
  }

  /** Crop one annotation rect out of the single whole-page render. */
  function cropAnnotation(sourceCanvas, rect, pageWidth, pageHeight, scaleX, scaleY, maxWidth, maxHeight, usedBytes) {
    var left = clamp(rect.x - SHOT_PADDING, 0, pageWidth);
    var top = clamp(rect.y - SHOT_PADDING, 0, pageHeight);
    var right = clamp(rect.x + rect.width + SHOT_PADDING, 0, pageWidth);
    var bottom = clamp(rect.y + rect.height + SHOT_PADDING, 0, pageHeight);
    var cropWidth = right - left;
    var cropHeight = bottom - top;
    if (!(cropWidth >= 1) || !(cropHeight >= 1)) return { error: 'empty-rect' };

    var sourceX = left * scaleX;
    var sourceY = top * scaleY;
    var sourceWidth = cropWidth * scaleX;
    var sourceHeight = cropHeight * scaleY;

    var outScale = Math.min(1, maxWidth / cropWidth, maxHeight / cropHeight);
    var outWidth = Math.max(1, Math.round(cropWidth * outScale));
    var outHeight = Math.max(1, Math.round(cropHeight * outScale));

    var encoded = encodeCrop(sourceCanvas, sourceX, sourceY, sourceWidth, sourceHeight, outWidth, outHeight);
    if (!encoded || encoded.error) return encoded || { error: 'encode-failed' };

    var guard = 0;
    while (encoded.bytes > SHOT_MAX_SINGLE_BYTES && guard < 8 && encoded.width > 16 && encoded.height > 16) {
      guard += 1;
      var singleWidth = Math.max(1, Math.floor(encoded.width * 0.75));
      var singleHeight = Math.max(1, Math.floor(encoded.height * 0.75));
      if (singleWidth === encoded.width && singleHeight === encoded.height) break;
      var singleRetry = encodeCrop(sourceCanvas, sourceX, sourceY, sourceWidth, sourceHeight, singleWidth, singleHeight);
      if (!singleRetry || singleRetry.error) break;
      encoded = singleRetry;
    }
    if (encoded.bytes > SHOT_MAX_SINGLE_BYTES) return { error: 'image-too-large' };

    var batchGuard = 0;
    while (
      usedBytes + encoded.bytes > SHOT_MAX_BATCH_BYTES &&
      batchGuard < 8 &&
      encoded.width > 16 &&
      encoded.height > 16
    ) {
      batchGuard += 1;
      var batchWidth = Math.max(1, Math.floor(encoded.width * 0.7));
      var batchHeight = Math.max(1, Math.floor(encoded.height * 0.7));
      if (batchWidth === encoded.width && batchHeight === encoded.height) break;
      var batchRetry = encodeCrop(sourceCanvas, sourceX, sourceY, sourceWidth, sourceHeight, batchWidth, batchHeight);
      if (!batchRetry || batchRetry.error) break;
      encoded = batchRetry;
    }
    if (usedBytes + encoded.bytes > SHOT_MAX_BATCH_BYTES) return { error: 'batch-too-large' };

    return encoded;
  }

  function encodeCrop(sourceCanvas, sourceX, sourceY, sourceWidth, sourceHeight, width, height) {
    var output = null;
    try {
      output = document.createElement('canvas');
      output.width = width;
      output.height = height;
      var context = output.getContext('2d');
      if (!context) return { error: 'canvas-unavailable' };
      context.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in context) context.imageSmoothingQuality = 'high';
      context.drawImage(sourceCanvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
      var dataUrl = output.toDataURL('image/png');
      if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/png') !== 0) return { error: 'encode-failed' };
      return { dataUrl: dataUrl, width: width, height: height, bytes: dataUrlBytes(dataUrl) };
    } catch (error) {
      // e.g. SecurityError when the page tainted the render canvas.
      return { error: 'encode-failed' };
    } finally {
      if (output) {
        try {
          output.width = 0;
          output.height = 0;
        } catch (error) {
          /* ignore */
        }
      }
    }
  }

  /* ================================================================== *
   * 10. parent messages + bootstrap
   * ================================================================== */

  function onMessage(event) {
    var data = event && event.data;
    if (!data || typeof data !== 'object' || data.channel !== CHANNEL) return;
    // SPEC §3: only the embedding parent may drive the runtime.
    if (event.source !== window.parent) return;
    var payload = data.payload && typeof data.payload === 'object' ? data.payload : {};

    switch (data.type) {
      case 'hello':
        postReady();
        break;
      case 'set-mode':
        applyMode(!!payload.active, true);
        break;
      case 'set-annotations':
        setAnnotations(payload.annotations);
        break;
      case 'focus-annotation':
        if (payload.id != null) focusAnnotation(String(payload.id));
        break;
      case 'capture-screenshots':
        handleCaptureRequest(data);
        break;
      case 'clear':
        clearAll();
        break;
      default:
        break;
    }
  }

  function installActiveListeners() {
    if (activeListeners) return;
    activeListeners = {
      pointerdown: guard(onPointerDown),
      pointermove: guard(onPointerMove),
      pointerup: guard(onPointerUp),
      pointercancel: guard(onPointerCancel),
      click: guard(onClickCapture),
      dblclick: guard(onClickCapture),
      contextmenu: guard(onContextMenu),
      keydown: guard(onKeyDown),
      keyup: guard(onKeyUp)
    };
    window.addEventListener('pointerdown', activeListeners.pointerdown, true);
    window.addEventListener('pointermove', activeListeners.pointermove, true);
    window.addEventListener('pointerup', activeListeners.pointerup, true);
    window.addEventListener('pointercancel', activeListeners.pointercancel, true);
    window.addEventListener('click', activeListeners.click, true);
    window.addEventListener('dblclick', activeListeners.dblclick, true);
    window.addEventListener('contextmenu', activeListeners.contextmenu, true);
    window.addEventListener('keydown', activeListeners.keydown, true);
    window.addEventListener('keyup', activeListeners.keyup, true);
  }

  function removeActiveListeners() {
    if (!activeListeners) return;
    window.removeEventListener('pointerdown', activeListeners.pointerdown, true);
    window.removeEventListener('pointermove', activeListeners.pointermove, true);
    window.removeEventListener('pointerup', activeListeners.pointerup, true);
    window.removeEventListener('pointercancel', activeListeners.pointercancel, true);
    window.removeEventListener('click', activeListeners.click, true);
    window.removeEventListener('dblclick', activeListeners.dblclick, true);
    window.removeEventListener('contextmenu', activeListeners.contextmenu, true);
    window.removeEventListener('keydown', activeListeners.keydown, true);
    window.removeEventListener('keyup', activeListeners.keyup, true);
    activeListeners = null;
  }

  function installPageListeners() {
    window.addEventListener('scroll', guard(scheduleRedraw), { passive: true, capture: true });
    window.addEventListener('resize', guard(scheduleRedraw), { passive: true });
    window.addEventListener('load', guard(scheduleRedraw), { passive: true });
    window.addEventListener('popstate', guard(postReady), { passive: true });
    window.addEventListener('hashchange', guard(postReady), { passive: true });
    window.addEventListener('blur', guard(onWindowBlur));
    window.addEventListener('message', guard(onMessage));
    // v1.5 SPEC §14.3: keep page links inside the proxy + route window.open.
    document.addEventListener('click', guard(onDocumentClickCapture), true);
    installWindowOpenBridge();
  }

  function init() {
    try {
      ensureRoot();
      installPageListeners();
      applyMode(false, false);
      postReady();
    } catch (error) {
      reportError(error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', guard(init), { once: true });
  } else {
    guard(init)();
  }
})();
